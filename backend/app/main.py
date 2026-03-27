import logging
import subprocess
from pathlib import Path
import os

from fastapi import FastAPI, File, HTTPException, UploadFile, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from twilio.rest import Client

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

app = FastAPI(
    title="Privacy-Preserving KYC Backend",
    version="0.1.0",
)

# ✅ ADD ROUTER PREFIX
api = APIRouter(prefix="/api")

# -------------------------------
# TWILIO SETUP
# -------------------------------
twilio_client = Client(
    os.getenv("TWILIO_ACCOUNT_SID"),
    os.getenv("TWILIO_AUTH_TOKEN")
)

VERIFY_SERVICE_SID = os.getenv("TWILIO_VERIFY_SERVICE_SID")

# -------------------------------
# CORS
# -------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------
# HEALTH
# -------------------------------
@api.get("/health")
async def health():
    return {"status": "ok", "environment": settings.app_env}


@api.get("/HEALTH")
@api.get("/Health")
async def health_alias():
    return await health()

# -------------------------------
# OTP SEND (REAL TWILIO)
# -------------------------------
@api.post("/otp/send")
async def send_otp(payload: dict):
    phone = payload.get("phone")

    if not phone:
        return {"success": False, "message": "Phone required"}

    try:
        twilio_client.verify.v2.services(VERIFY_SERVICE_SID).verifications.create(
            to=f"+91{phone}",
            channel="sms"
        )
        return {"success": True, "message": "OTP sent successfully"}

    except Exception as e:
        _logger.error(f"Twilio error: {e}")
        return {"success": False, "message": str(e)}

# -------------------------------
# OTP VERIFY
# -------------------------------
@api.post("/otp/verify")
async def verify_otp(payload: dict):
    phone = payload.get("phone")
    otp = payload.get("otp")

    try:
        result = twilio_client.verify.v2.services(VERIFY_SERVICE_SID).verification_checks.create(
            to=f"+91{phone}",
            code=otp
        )

        if result.status == "approved":
            return {"success": True}

        return {"success": False, "message": "Invalid OTP"}

    except Exception as e:
        return {"success": False, "message": str(e)}

# -------------------------------
# AADHAAR SCAN (UNCHANGED)
# -------------------------------
@api.post("/scan-aadhaar")
async def scan_aadhaar(
    file: UploadFile | None = File(default=None),
    image: UploadFile | None = File(default=None),
):
    upload = file or image

    if upload is None:
        return {"success": False, "message": "Missing file"}

    if upload.content_type not in ALLOWED_CONTENT_TYPES:
        return {"success": False, "message": "Invalid format"}

    try:
        image_bytes = await upload.read()
        cv_image = read_image(image_bytes)
        result = detect_qr(cv_image)
    except Exception:
        return {"success": False, "message": "Processing failed"}

    if not result.success:
        return {"success": False, "message": "QR not detected"}

    return {"success": True, "qr_data": result.qr_data}

# -------------------------------
# VERIFY PROOF (UNCHANGED CORE)
# -------------------------------
@api.post("/verify-proof", response_model=VerifyProofResponse)
async def verify_proof(payload: VerifyProofRequest):

    scheme = (payload.scheme or "").strip()
    is_commitment = scheme == "groth16-flexible-kyc-commitment" or len(payload.publicSignals) == 18
    vkey_path = FLEXIBLE_KYC_COMMITMENT_VKEY_PATH if is_commitment else FLEXIBLE_KYC_VKEY_PATH

    if not vkey_path.exists():
        return VerifyProofResponse(verified=False, message="Verification key missing")

    ctx = payload.requestContext
    if ctx is None:
        return VerifyProofResponse(verified=False, message="Missing requestContext")

    expected_nonce = (ctx.security or {}).get("nonce")

    if not public_signals_match_request(
        payload.publicSignals,
        created_at_ms=ctx.createdAt,
        checks=ctx.checks,
        constraints=ctx.constraints,
        nonce=expected_nonce,
    ):
        return VerifyProofResponse(verified=False, message="Public signals mismatch")

    try:
        result: VerificationResult = verify_groth16(
            proof=payload.proof,
            public_signals=payload.publicSignals,
            vkey_path=vkey_path,
        )
    except Exception as e:
        _logger.error(e)
        raise HTTPException(500, "Verification failed")

    if result.valid:
        return VerifyProofResponse(verified=True, message="ZK proof verified")

    return VerifyProofResponse(verified=False, message="Invalid proof")

# -------------------------------
# REGISTER ROUTER
# -------------------------------
app.include_router(api)
