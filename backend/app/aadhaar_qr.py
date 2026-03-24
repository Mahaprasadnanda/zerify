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
DEFAULT_SCAN_TIMEOUT_SEC = 2.8
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
    return normalize_image(bgr)


def normalize_image(image: np.ndarray) -> np.ndarray:
    if len(image.shape) == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    norm_gray = clahe.apply(gray)
    return cv2.cvtColor(norm_gray, cv2.COLOR_GRAY2BGR)


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
    edges = cv2.Canny(gray, 80, 220)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    h, w = gray.shape[:2]
    min_area = max(900, int((h * w) * 0.001))
    candidates: list[tuple[np.ndarray, dict[str, int]]] = []

    for cnt in contours:
        x, y, cw, ch = cv2.boundingRect(cnt)
        area = cw * ch
        if area < min_area:
            continue
        ratio = cw / max(ch, 1)
        if ratio < 0.7 or ratio > 1.3:
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
    return candidates[:25]


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


def _decode_from_image(image: np.ndarray, method: str) -> QrDetectionResult | None:
    if _PYZBAR_AVAILABLE and zbar_decode is not None:
        decoded = zbar_decode(image)
        for item in decoded:
            text = _decode_text(item.data)
            if not _is_valid_qr_payload(text):
                continue
            bbox = {"x": item.rect.left, "y": item.rect.top, "w": item.rect.width, "h": item.rect.height}
            return QrDetectionResult(success=True, qr_data=text, message="QR code detected", method=f"pyzbar:{method}", bbox=bbox)

    data, points, _ = _QR_DETECTOR.detectAndDecode(image)
    text = (data or "").strip()
    if _is_valid_qr_payload(text):
        bbox = None
        if points is not None and len(points) > 0:
            xs = [int(p[0]) for p in points[0]]
            ys = [int(p[1]) for p in points[0]]
            bbox = {
                "x": max(0, min(xs)),
                "y": max(0, min(ys)),
                "w": max(xs) - min(xs),
                "h": max(ys) - min(ys),
            }
        return QrDetectionResult(success=True, qr_data=text, message="QR code detected", method=f"opencv:{method}", bbox=bbox)
    return None


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
        for method, variant in preprocess_variants(rotated):
            if timed_out():
                break
            result = _decode_from_image(variant, f"rotation_{angle}:{method}")
            if result:
                if debug:
                    _logger.info("aadhaar-qr: success via %s", result.method)
                return result

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
