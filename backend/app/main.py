import logging
import subprocess
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.aadhaar_qr import (
    ALLOWED_CONTENT_TYPES,
    detect_qr,
    read_image,
)
from app.flexible_kyc_public import public_signals_match_request
from app.schemas import (
    VerifyProofRequest,
    VerifyProofResponse,
)
from app.verifier import VerificationResult, verify_groth16
from app.nonce_store import try_mark_nonce_used

settings = get_settings()

_BACKEND_APP = Path(__file__).resolve().parent

FLEXIBLE_KYC_VKEY_PATH = _BACKEND_APP / "flexible_kyc_verification_key.json"
FLEXIBLE_KYC_COMMITMENT_VKEY_PATH = (
    _BACKEND_APP / "flexible_kyc_commitment_verification_key.json"
)

print(f"[Zerify ZKP] Using flexibleKyc ZKP artifacts: {FLEXIBLE_KYC_VKEY_PATH.resolve()}")
_logger = logging.getLogger(__name__)
_logger.info(
    "Using flexibleKyc ZKP artifacts: %s",
    FLEXIBLE_KYC_VKEY_PATH,
)

app = FastAPI(
    title="Privacy-Preserving KYC Backend",
    version="0.1.0",
    description=(
        "Starter FastAPI service for verifying zero-knowledge proofs without "
        "receiving raw Aadhaar-derived personal data."
    ),
)

# -------------------------------------------------------
# CORS CONFIGURATION
# -------------------------------------------------------
# Next.js dev is often opened as http://127.0.0.1:3000 OR http://localhost:3000 — both must be allowed
# or the browser sends OPTIONS then never sends POST (verifier stuck on "Verifying…").

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:[0-9]+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# -------------------------------------------------------
# HEALTH CHECK
# -------------------------------------------------------

@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "environment": settings.app_env,
    }


# Convenience aliases (avoid confusion in manual testing tools / bookmarks).
@app.get("/HEALTH")
@app.get("/Health")
async def health_alias() -> dict[str, str]:
    return await health()


@app.post("/scan-aadhaar")
async def scan_aadhaar(
    file: UploadFile | None = File(default=None),
    image: UploadFile | None = File(default=None),
) -> dict[str, object]:
    upload = file or image
    if upload is None:
        return {
            "success": False,
            "qr_data": None,
            "message": "Missing file upload.",
        }

    if upload.content_type not in ALLOWED_CONTENT_TYPES:
        return {
            "success": False,
            "qr_data": None,
            "message": "Unsupported image format. Use jpg/jpeg/png.",
        }

    try:
        image_bytes = await upload.read()
        cv_image = read_image(image_bytes)
        result = detect_qr(cv_image, debug=False)
    except ValueError as exc:
        return {
            "success": False,
            "qr_data": None,
            "message": str(exc),
        }
    except Exception:
        _logger.exception("scan-aadhaar: unexpected processing failure")
        return {
            "success": False,
            "qr_data": None,
            "message": "Failed to process image.",
        }

    if not result.success:
        return {
            "success": False,
            "qr_data": None,
            "message": "QR code not detected",
        }

    return {
        "success": True,
        "qr_data": result.qr_data,
        "message": "QR code detected",
        "method": result.method,
        "bbox": result.bbox,
    }

# -------------------------------------------------------
# GROTH16 (flexibleKyc circuit only)
# -------------------------------------------------------

@app.post("/verify-proof", response_model=VerifyProofResponse)
async def verify_proof(payload: VerifyProofRequest) -> VerifyProofResponse:
    _logger.info("verify-proof: request received")
    scheme = (payload.scheme or "").strip()
    # Backward compatible: allow scheme hint OR infer from publicSignals length.
    # flexibleKyc (v2) publicSignals: 17 (includes nonce)
    # flexibleKycCommitment (v2) publicSignals: 18 (includes nonce + commitment)
    is_commitment = scheme == "groth16-flexible-kyc-commitment" or len(payload.publicSignals) == 18
    vkey_path = FLEXIBLE_KYC_COMMITMENT_VKEY_PATH if is_commitment else FLEXIBLE_KYC_VKEY_PATH

    if not vkey_path.exists():
        return VerifyProofResponse(
            verified=False,
            message=(
                f"{vkey_path.name} is missing. Run the relevant compile script and copy the verification key "
                "into backend/app/."
            ),
        )

    ctx = payload.requestContext
    if ctx is None:
        return VerifyProofResponse(
            verified=False,
            message="requestContext is required to bind public signals to a KYC request.",
        )

    require_commitment = bool((ctx.security or {}).get("requireCommitment"))
    if require_commitment and not is_commitment:
        return VerifyProofResponse(
            verified=False,
            message="This request requires a commitment-bound proof, but a standard proof was provided.",
        )

    expected_nonce = (ctx.security or {}).get("nonce")
    if expected_nonce:
        if not payload.nonce:
            return VerifyProofResponse(
                verified=False,
                message="This request requires a nonce-bound proof, but no nonce was provided.",
            )
        if payload.nonce != expected_nonce:
            return VerifyProofResponse(
                verified=False,
                message="Nonce does not match this KYC request.",
            )

    expected_nonce_field = (ctx.security or {}).get("nonce")
    if not public_signals_match_request(
        payload.publicSignals,
        created_at_ms=ctx.createdAt,
        checks=ctx.checks,
        constraints=ctx.constraints,
        nonce=expected_nonce_field,
    ):
        return VerifyProofResponse(
            verified=False,
            message="Public signals do not match the stated KYC request constraints.",
        )

    try:
        result: VerificationResult = verify_groth16(
            proof=payload.proof,
            public_signals=payload.publicSignals,
            vkey_path=vkey_path,
        )
    except FileNotFoundError as exc:
        _logger.error("Verifier setup error — missing file: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Verifier is not configured correctly. Contact the administrator.",
        ) from exc
    except EnvironmentError as exc:
        _logger.error("Node.js not available: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Proof verifier is unavailable. Contact the administrator.",
        ) from exc
    except subprocess.TimeoutExpired:
        _logger.error("Proof verification timed out")
        raise HTTPException(
            status_code=504,
            detail="Proof verification timed out. Try again.",
        )
    except RuntimeError as exc:
        _logger.error("Verifier subprocess error: %s", exc)
        raise HTTPException(
            status_code=500,
            detail="Internal verifier error. Contact the administrator.",
        ) from exc

    if result.error is not None:
        _logger.error("snark_verifier.js reported error: %s", result.error)
        raise HTTPException(
            status_code=500,
            detail="Internal verifier error. Contact the administrator.",
        )

    _logger.info("Proof verification complete | valid=%s", result.valid)

    if result.valid:
        # Replay protection: if the request carries a nonce, enforce single-use.
        # This prevents:
        #  - proof replay within the same request
        #  - cross-request reuse when a unique nonce is generated per request
        if expected_nonce:
            try:
                fresh = try_mark_nonce_used(str(expected_nonce))
            except Exception:
                _logger.exception("verify-proof: nonce replay store failed")
                raise HTTPException(
                    status_code=500,
                    detail="Nonce replay protection is unavailable. Contact the administrator.",
                )

            if not fresh:
                return VerifyProofResponse(
                    verified=False,
                    message="Nonce already used (replay detected).",
                )

        return VerifyProofResponse(verified=True, message="ZK proof verified.")

    return VerifyProofResponse(verified=False, message="ZK proof is invalid.")
