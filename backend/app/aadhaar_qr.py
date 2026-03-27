from __future__ import annotations

import logging
import time
from dataclasses import dataclass
import io
from typing import Generator

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

try:
    from pyzbar.pyzbar import decode as zbar_decode
    _PYZBAR_AVAILABLE = True
except Exception:
    zbar_decode = None
    _PYZBAR_AVAILABLE = False

_logger = logging.getLogger(__name__)

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/jpg", "image/png"}
# Full card scans need more time: multi-scale + region crops before giving up.
DEFAULT_SCAN_TIMEOUT_SEC = 14.0
_QR_DETECTOR = cv2.QRCodeDetector()


@dataclass
class QrDetectionResult:
    success: bool
    qr_data: str | None = None
    message: str = ""
    method: str | None = None
    bbox: dict[str, int] | None = None


def read_image(image_bytes: bytes) -> np.ndarray:
    if not image_bytes:
        raise ValueError("Empty image payload.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ValueError("Image too large. Max supported size is 10MB.")
    try:
        pil_img = Image.open(io.BytesIO(image_bytes))
        pil_img.load()
    except UnidentifiedImageError as exc:
        raise ValueError("Unsupported or corrupt image.") from exc
    except Exception as exc:
        raise ValueError("Failed to read image.") from exc
    if pil_img.mode not in ("RGB", "L"):
        pil_img = pil_img.convert("RGB")
    elif pil_img.mode == "L":
        pil_img = pil_img.convert("RGB")
    arr = np.array(pil_img)
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    # Do not apply CLAHE here — it often hurts QR module patterns on full-page photos.
    # CLAHE is optional inside preprocess_variants only.
    return bgr


def normalize_image(image: np.ndarray) -> np.ndarray:
    if len(image.shape) == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    norm_gray = clahe.apply(gray)
    return cv2.cvtColor(norm_gray, cv2.COLOR_GRAY2BGR)


def apply_clahe_bgr(image: np.ndarray) -> np.ndarray:
    """Optional contrast norm; kept as one decode variant, not the default input."""
    return normalize_image(image)


def rotate_image(image: np.ndarray, angle: int) -> np.ndarray:
    if angle % 360 == 0:
        return image
    if angle % 360 == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if angle % 360 == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    if angle % 360 == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    h, w = image.shape[:2]
    center = (w // 2, h // 2)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(image, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def preprocess_variants(image: np.ndarray) -> Generator[tuple[str, np.ndarray], None, None]:
    scales = (1.0, 1.5, 2.0, 0.5)
    for scale in scales:
        if scale == 1.0:
            scaled = image
        else:
            scaled = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)

        # CLAHE helps some lighting; optional after raw attempts in detect_qr.
        yield (f"clahe_scale_{scale}", apply_clahe_bgr(scaled))

        yield (f"direct_scale_{scale}", scaled)

        gray = cv2.cvtColor(scaled, cv2.COLOR_BGR2GRAY)
        yield (f"gray_scale_{scale}", gray)

        _, binary = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        yield (f"threshold_binary_scale_{scale}", binary)

        adaptive = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 8)
        yield (f"threshold_adaptive_scale_{scale}", adaptive)

        _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        yield (f"threshold_otsu_scale_{scale}", otsu)

        gauss = cv2.GaussianBlur(gray, (5, 5), 0)
        yield (f"gaussian_blur_scale_{scale}", gauss)

        median = cv2.medianBlur(gray, 3)
        yield (f"median_blur_scale_{scale}", median)

        canny = cv2.Canny(gray, 80, 220)
        yield (f"canny_scale_{scale}", canny)

        kernel = np.ones((3, 3), np.uint8)
        dilated = cv2.dilate(gray, kernel, iterations=1)
        yield (f"dilate_scale_{scale}", dilated)
        eroded = cv2.erode(gray, kernel, iterations=1)
        yield (f"erode_scale_{scale}", eroded)


def extract_candidate_regions(image: np.ndarray) -> list[tuple[np.ndarray, dict[str, int]]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
    edges = cv2.Canny(gray, 50, 180)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    h, w = gray.shape[:2]
    # Smaller minimum area so a distant QR on a full card can still be cropped.
    min_area = max(400, int((h * w) * 0.00025))
    candidates: list[tuple[np.ndarray, dict[str, int]]] = []

    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        area = cw * ch
        if area < min_area:
            continue
        ratio = cw / max(ch, 1)
        if ratio < 0.65 or ratio > 1.45:
            continue
        pad = int(min(cw, ch) * 0.1)
        x0 = max(0, x - pad)
        y0 = max(0, y - pad)
        x1 = min(w, x + cw + pad)
        y1 = min(h, y + ch + pad)
        crop = image[y0:y1, x0:x1]
        if crop.size == 0:
            continue
        candidates.append((crop, {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}))

    candidates.sort(key=lambda item: item[1]["w"] * item[1]["h"], reverse=True)
    return candidates[:40]


def _multiscale_full_image_variants(image: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """Down/up-scale full frame so decoders see QR modules at a workable size."""
    h, w = image.shape[:2]
    longest = max(h, w)
    out: list[tuple[str, np.ndarray]] = [("native", image)]
    if longest > 2600:
        for max_dim in (2200, 1800, 1400):
            s = max_dim / longest
            out.append(
                (
                    f"down_{max_dim}",
                    cv2.resize(image, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA),
                )
            )
    elif longest > 2000:
        s = 1800 / longest
        out.append(("down_1800", cv2.resize(image, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)))
    elif longest < 1600:
        for mag, tag in ((1.5, "up15"), (2.0, "up2"), (2.5, "up25")):
            out.append(
                (
                    tag,
                    cv2.resize(image, (max(1, int(w * mag)), max(1, int(h * mag))), interpolation=cv2.INTER_CUBIC),
                )
            )
    return out


def _multiscale_crop_variants(crop: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """Fewer variants when the image is already a cropped region."""
    h, w = crop.shape[:2]
    longest = max(h, w)
    out: list[tuple[str, np.ndarray]] = [("native", crop)]
    if longest < 1000:
        for mag, tag in ((1.5, "up15"), (2.0, "up2")):
            out.append(
                (
                    tag,
                    cv2.resize(crop, (max(1, int(w * mag)), max(1, int(h * mag))), interpolation=cv2.INTER_CUBIC),
                )
            )
    elif longest > 2200:
        s = 2000 / longest
        out.append(("down", cv2.resize(crop, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)))
    return out


def _quick_binary_bgr(bgr: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """Cheap binarizations that often help pyzbar on document photos."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    out: list[tuple[str, np.ndarray]] = []
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    out.append(("otsu", cv2.cvtColor(otsu, cv2.COLOR_GRAY2BGR)))
    adaptive = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 41, 10)
    out.append(("adaptive", cv2.cvtColor(adaptive, cv2.COLOR_GRAY2BGR)))
    _, inv = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    out.append(("otsu_inv", cv2.cvtColor(inv, cv2.COLOR_GRAY2BGR)))
    return out


def _region_crops(image: np.ndarray) -> list[tuple[np.ndarray, dict[str, int]]]:
    """Likely regions for Aadhaar secure QR (often lower / corner on back side)."""
    h, w = image.shape[:2]
    crops: list[tuple[np.ndarray, dict[str, int]]] = []
    hh, ww = h // 2, w // 2
    for (y0, y1, x0, x1, _tag) in (
        (0, hh, 0, ww),
        (0, hh, ww, w),
        (hh, h, 0, ww),
        (hh, h, ww, w),
    ):
        crop = image[y0:y1, x0:x1]
        if crop.size:
            crops.append((crop, {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}))
    y0 = int(h * 0.42)
    crop = image[y0:h, 0:w]
    crops.append((crop, {"x": 0, "y": y0, "w": w, "h": h - y0}))
    x0, y0 = int(w * 0.42), int(h * 0.38)
    crop = image[y0:h, x0:w]
    if crop.size:
        crops.append((crop, {"x": x0, "y": y0, "w": w - x0, "h": h - y0}))
    mx0, my0 = int(w * 0.1), int(h * 0.1)
    mx1, my1 = int(w * 0.9), int(h * 0.9)
    crop = image[my0:my1, mx0:mx1]
    if crop.size:
        crops.append((crop, {"x": mx0, "y": my0, "w": mx1 - mx0, "h": my1 - my0}))
    return crops


def _front_back_panel_crops(img: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """
    Front+back in one image (side-by-side or stacked): UIDAI secure QR is only on the back.
    Full-frame decode shrinks the QR; dashed 'cut here' art between panels can confuse detectors.
    We crop the likely back panel first at native resolution.
    """
    h, w = img.shape[:2]
    out: list[tuple[str, np.ndarray]] = []
    # Landscape composite: back is usually the RIGHT half (UIDAI back with large QR).
    if w >= h * 1.12:
        for x_frac, tag in (
            (0.50, "back_right50"),
            (0.48, "back_right52"),
            (0.45, "back_right55"),
            (0.52, "back_right48"),
            (0.40, "back_right60"),
        ):
            x0 = int(w * x_frac)
            if w - x0 >= 120:
                out.append((tag, img[:, x0:w]))
        mid = w // 2
        gutter = max(8, int(w * 0.018))
        if mid + gutter < w - 40:
            out.append(("back_right_nogutter", img[:, mid + gutter : w]))
        if mid - gutter > 40:
            out.append(("front_left_only", img[:, : mid - gutter]))
    # Portrait composite: back sometimes below front
    if h >= w * 1.12:
        for y_frac, tag in (
            (0.48, "back_bottom52"),
            (0.45, "back_bottom55"),
            (0.50, "back_bottom50"),
        ):
            y0 = int(h * y_frac)
            if h - y0 >= 120:
                out.append((tag, img[y0:h, :]))
    return out


def _decode_text(raw: bytes) -> str:
    try:
        return raw.decode("utf-8").strip()
    except UnicodeDecodeError:
        return raw.decode("latin-1", errors="ignore").strip()


def _is_valid_qr_payload(text: str) -> bool:
    if not text:
        return False
    if len(text) < 12:
        return False
    return True


def _bbox_from_quad(points: np.ndarray | None) -> dict[str, int] | None:
    if points is None or len(points) == 0:
        return None
    xs = [int(p[0]) for p in points]
    ys = [int(p[1]) for p in points]
    return {
        "x": max(0, min(xs)),
        "y": max(0, min(ys)),
        "w": max(xs) - min(xs),
        "h": max(ys) - min(ys),
    }


def _collect_qr_candidates(image: np.ndarray) -> list[tuple[str, dict[str, int] | None]]:
    """All decoded strings in the image (pyzbar + OpenCV), for best-of selection."""
    candidates: list[tuple[str, dict[str, int] | None]] = []
    if _PYZBAR_AVAILABLE and zbar_decode is not None:
        for item in zbar_decode(image):
            text = _decode_text(item.data)
            if not _is_valid_qr_payload(text):
                continue
            bbox = {"x": item.rect.left, "y": item.rect.top, "w": item.rect.width, "h": item.rect.height}
            candidates.append((text, bbox))

    try:
        ok, decoded_info, points, _ = _QR_DETECTOR.detectAndDecodeMulti(image)
        if ok and decoded_info is not None:
            infos = list(decoded_info) if not isinstance(decoded_info, str) else [decoded_info]
            for i, data in enumerate(infos):
                text = (data or "").strip()
                if not _is_valid_qr_payload(text):
                    continue
                bbox = None
                if points is not None and len(points) > i:
                    bbox = _bbox_from_quad(np.asarray(points[i]))
                candidates.append((text, bbox))
    except Exception:
        pass

    data, pts, _ = _QR_DETECTOR.detectAndDecode(image)
    text = (data or "").strip()
    if _is_valid_qr_payload(text):
        bbox = _bbox_from_quad(pts[0] if pts is not None and len(pts) > 0 else None)
        candidates.append((text, bbox))

    return candidates


def _pick_best_aadhaar_qr(candidates: list[tuple[str, dict[str, int] | None]]) -> tuple[str, dict[str, int] | None] | None:
    """Prefer UIDAI secure QR: long all-decimal string; avoid short URL/marketing QRs on the card."""
    if not candidates:
        return None
    digit_long = [(t, b) for t, b in candidates if t.isdigit() and len(t) >= 200]
    if digit_long:
        return max(digit_long, key=lambda x: len(x[0]))
    digit_mid = [(t, b) for t, b in candidates if t.isdigit() and len(t) >= 80]
    if digit_mid:
        return max(digit_mid, key=lambda x: len(x[0]))
    digit_any = [(t, b) for t, b in candidates if t.isdigit()]
    if digit_any:
        return max(digit_any, key=lambda x: len(x[0]))
    # Never return http(s) / marketing strings as the secure payload — keep scanning other crops.
    return None


def _decode_from_image(image: np.ndarray, method: str) -> QrDetectionResult | None:
    candidates = _collect_qr_candidates(image)
    picked = _pick_best_aadhaar_qr(candidates)
    if picked is None:
        return None
    text, bbox = picked
    return QrDetectionResult(success=True, qr_data=text, message="QR code detected", method=f"multi:{method}", bbox=bbox)


def detect_qr(image: np.ndarray, *, timeout_sec: float = DEFAULT_SCAN_TIMEOUT_SEC, debug: bool = False) -> QrDetectionResult:
    if debug and not _PYZBAR_AVAILABLE:
        _logger.warning("aadhaar-qr: pyzbar unavailable, using OpenCV QRCodeDetector fallback")
    start = time.perf_counter()

    def timed_out() -> bool:
        return (time.perf_counter() - start) > timeout_sec

    for angle in (0, 90, 180, 270):
        if timed_out():
            break
        rotated = rotate_image(image, angle)

        # Phase 0: front+back composite — back panel only (secure QR is larger in crop than in full frame)
        for pname, panel in _front_back_panel_crops(rotated):
            if timed_out():
                break
            for name, scaled in _multiscale_full_image_variants(panel):
                if timed_out():
                    break
                result = _decode_from_image(scaled, f"rotation_{angle}:panel:{pname}:{name}")
                if result:
                    if debug:
                        _logger.info("aadhaar-qr: success via %s", result.method)
                    return result
            for mname, scaled in _multiscale_full_image_variants(panel):
                if timed_out():
                    break
                for bname, bimg in _quick_binary_bgr(scaled):
                    if timed_out():
                        break
                    result = _decode_from_image(bimg, f"rotation_{angle}:panel_bin:{pname}:{mname}:{bname}")
                    if result:
                        if debug:
                            _logger.info("aadhaar-qr: success via %s", result.method)
                        return result

        # Phase 1: full-frame multi-scale (raw BGR — best for full card photos)
        for name, scaled in _multiscale_full_image_variants(rotated):
            if timed_out():
                break
            result = _decode_from_image(scaled, f"rotation_{angle}:quick_bgr:{name}")
            if result:
                if debug:
                    _logger.info("aadhaar-qr: success via %s", result.method)
                return result

        # Phase 2: full-frame + binarizations (helps low-contrast prints)
        for mname, scaled in _multiscale_full_image_variants(rotated):
            if timed_out():
                break
            for bname, bimg in _quick_binary_bgr(scaled):
                if timed_out():
                    break
                result = _decode_from_image(bimg, f"rotation_{angle}:quick_bin:{mname}:{bname}")
                if result:
                    if debug:
                        _logger.info("aadhaar-qr: success via %s", result.method)
                    return result

        # Phase 3: likely regions (QR often on lower half / corner of back)
        for cidx, (crop, coords) in enumerate(_region_crops(rotated)):
            if timed_out():
                break
            for name, scaled in _multiscale_crop_variants(crop):
                if timed_out():
                    break
                result = _decode_from_image(scaled, f"rotation_{angle}:region_{cidx}:{name}")
                if result:
                    result.bbox = coords
                    if debug:
                        _logger.info("aadhaar-qr: success via %s", result.method)
                    return result
            for name, scaled in _multiscale_crop_variants(crop):
                if timed_out():
                    break
                for bname, bimg in _quick_binary_bgr(scaled):
                    if timed_out():
                        break
                    result = _decode_from_image(bimg, f"rotation_{angle}:region_{cidx}_bin:{name}:{bname}")
                    if result:
                        result.bbox = coords
                        if debug:
                            _logger.info("aadhaar-qr: success via %s", result.method)
                        return result

        # Phase 4: heavy per-scale preprocessing on full frame
        for method, variant in preprocess_variants(rotated):
            if timed_out():
                break
            result = _decode_from_image(variant, f"rotation_{angle}:{method}")
            if result:
                if debug:
                    _logger.info("aadhaar-qr: success via %s", result.method)
                return result

        # Phase 5: contour-based crops + preprocessing
        if timed_out():
            break
        for idx, (crop, coords) in enumerate(extract_candidate_regions(rotated)):
            if timed_out():
                break
            for method, variant in preprocess_variants(crop):
                if timed_out():
                    break
                result = _decode_from_image(variant, f"rotation_{angle}:crop_{idx}:{method}")
                if result:
                    result.bbox = coords
                    if debug:
                        _logger.info("aadhaar-qr: success via %s", result.method)
                    return result

    return QrDetectionResult(success=False, message="QR code not detected")
