import logging
import subprocess
from pathlib import Path
import os

from fastapi import FastAPI, File, HTTPException, UploadFile, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
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
from app.user_registry import is_user_registered, mark_user_registered

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
    os.getenv("TWILIO_ACCOUNT_SID") or settings.twilio_account_sid,
    os.getenv("TWILIO_AUTH_TOKEN") or settings.twilio_auth_token,
)

VERIFY_SERVICE_SID = (
    os.getenv("TWILIO_VERIFY_SERVICE_SID")
    or settings.twilio_verify_service_sid
    or settings.twilio_service_sid
)


class SmsSendRequest(BaseModel):
    phones: list[str] = Field(default_factory=list)
    requestId: str = ""


class UserRegistrationRequest(BaseModel):
    phone: str = ""


def normalize_to_e164_india(raw: str) -> str:
    digits = "".join(ch for ch in str(raw) if ch.isdigit())

    if len(digits) == 10:
        return f"+91{digits}"

    if digits.startswith("91") and len(digits) == 12:
        return f"+{digits}"

    raise ValueError("Invalid phone number. Expected a valid Indian mobile number.")


def mask_phone_number(phone: str) -> str:
    if len(phone) <= 4:
        return phone

    return f"{phone[:3]}{'*' * max(len(phone) - 7, 0)}{phone[-4:]}"


def sms_error_response(status_code: int, error: str, to: str = "") -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "ok": False,
            "sent": [],
            "failed": [{"to": to, "error": error}],
        },
    )


def parse_and_normalize_phone(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail="Phone required")

    try:
        return normalize_to_e164_india(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

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
# USER REGISTRATION
# -------------------------------
@api.post("/users/register")
async def register_user(payload: UserRegistrationRequest):
    phone_e164 = parse_and_normalize_phone(payload.phone)
    registered_at = mark_user_registered(phone_e164)

    _logger.info("Registered user phone=%s", mask_phone_number(phone_e164))

    return {
        "ok": True,
        "phone": phone_e164,
        "registered": True,
        "registeredAt": registered_at,
    }


@api.post("/users/exists")
async def check_registered_user(payload: UserRegistrationRequest):
    phone_e164 = parse_and_normalize_phone(payload.phone)
    registered = is_user_registered(phone_e164)

    return {
        "ok": True,
        "phone": phone_e164,
        "registered": registered,
    }


# -------------------------------
# SMS SEND
# -------------------------------
@api.post("/sms/send")
async def send_sms(payload: SmsSendRequest):
    request_id = payload.requestId.strip()
    phones = payload.phones or []

    if not request_id:
        _logger.warning("SMS send rejected: missing requestId")
        return sms_error_response(400, "Missing requestId")

    if not phones:
        _logger.warning("SMS send rejected for requestId=%s: missing phones", request_id)
        return sms_error_response(400, "Missing phones")

    normalized: list[str] = []
    for phone in phones:
        try:
            normalized.append(normalize_to_e164_india(phone))
        except ValueError as exc:
            invalid_phone = str(phone)
            _logger.warning(
                "SMS send rejected for requestId=%s: invalid phone input=%s",
                request_id,
                invalid_phone,
            )
            return sms_error_response(400, str(exc), invalid_phone)

    account_sid = (os.getenv("TWILIO_ACCOUNT_SID") or settings.twilio_account_sid or "").strip()
    auth_token = (os.getenv("TWILIO_AUTH_TOKEN") or settings.twilio_auth_token or "").strip()
    messaging_service_sid = (
        os.getenv("TWILIO_SMS_MESSAGING_SERVICE_SID")
        or settings.twilio_sms_messaging_service_sid
        or ""
    ).strip()
    sms_from = (os.getenv("TWILIO_SMS_FROM") or settings.twilio_sms_from or "").strip()

    if not account_sid or not auth_token:
        _logger.error("SMS send unavailable for requestId=%s: Twilio credentials not configured", request_id)
        return sms_error_response(500, "SMS service is not configured")

    if not messaging_service_sid and not sms_from:
        _logger.error(
            "SMS send unavailable for requestId=%s: missing messaging service SID and sender number",
            request_id,
        )
        return sms_error_response(500, "SMS service is not configured")

    sms_client = Client(account_sid, auth_token)

    text = (
        "You have a KYC request received. Please visit the Zerifyy site to complete KYC."
        f" Request ID: {request_id}"
    )

    _logger.info(
        "Sending SMS notifications for requestId=%s to=%s",
        request_id,
        ",".join(mask_phone_number(phone) for phone in normalized),
    )

    sent: list[str] = []
    failed: list[dict[str, str]] = []

    for to in normalized:
        try:
            message_args = {"to": to, "body": text}
            if messaging_service_sid:
                message_args["messaging_service_sid"] = messaging_service_sid
            else:
                message_args["from_"] = sms_from

            sms_client.messages.create(**message_args)
            sent.append(to)
        except Exception as exc:
            error_message = str(exc) or "Failed to send SMS"
            failed.append({"to": to, "error": error_message})
            _logger.exception(
                "SMS send failed for requestId=%s to=%s",
                request_id,
                mask_phone_number(to),
            )

    response = {
        "ok": len(failed) == 0,
        "sent": sent,
        "failed": failed,
    }

    if failed:
        return JSONResponse(status_code=500, content=response)

    return response

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
