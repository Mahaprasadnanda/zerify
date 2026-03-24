import json
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
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

settings = get_settings()

PROJECT_ROOT = Path(__file__).resolve().parents[2]

FLEXIBLE_KYC_VKEY_PATH = (
    PROJECT_ROOT
    / "frontend"
    / "public"
    / "zkp"
    / "flexibleKyc"
    / "flexible_kyc_verification_key.json"
)

print(f"[Zerify ZKP] Using flexibleKyc ZKP artifacts: {FLEXIBLE_KYC_VKEY_PATH.resolve()}")
_logger = logging.getLogger(__name__)
_logger.info(
    "Using flexibleKyc ZKP artifacts: %s",
    FLEXIBLE_KYC_VKEY_PATH,
)


def _snarkjs_verify_command(
    vkey_path: Path,
    public_signals_path: Path,
    proof_path: Path,
) -> list[str] | None:
    """Resolve a working snarkjs verify command for Windows/Linux shells."""
    # 1) repo-local binary (works even when npm global path is missing in uvicorn env)
    local_bin = PROJECT_ROOT / "node_modules" / ".bin" / "snarkjs.cmd"
    if local_bin.exists():
        return [
            str(local_bin),
            "groth16",
            "verify",
            str(vkey_path),
            str(public_signals_path),
            str(proof_path),
        ]

    # 2) npx.cmd is the typical Windows launcher
    npx_cmd = shutil.which("npx.cmd")
    if npx_cmd:
        return [
            npx_cmd,
            "--yes",
            "snarkjs",
            "groth16",
            "verify",
            str(vkey_path),
            str(public_signals_path),
            str(proof_path),
        ]

    # 3) plain npx (mac/linux or some Windows shells)
    npx = shutil.which("npx")
    if npx:
        return [
            npx,
            "--yes",
            "snarkjs",
            "groth16",
            "verify",
            str(vkey_path),
            str(public_signals_path),
            str(proof_path),
        ]

    return None

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


@app.post("/scan-aadhaar")
async def scan_aadhaar(image: UploadFile = File(...)) -> dict[str, object]:
    if image.content_type not in ALLOWED_CONTENT_TYPES:
        return {
            "success": False,
            "qr_data": None,
            "message": "Unsupported image format. Use jpg/jpeg/png.",
        }

    try:
        image_bytes = await image.read()
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
    if not FLEXIBLE_KYC_VKEY_PATH.exists():
        return VerifyProofResponse(
            verified=False,
            message=(
                "flexible_kyc_verification_key.json is missing. Run "
                "scripts/compile-flexible-kyc.ps1 and copy artifacts into "
                "frontend/public/zkp/flexibleKyc/."
            ),
        )

    ctx = payload.requestContext
    if ctx is None:
        return VerifyProofResponse(
            verified=False,
            message="requestContext is required to bind public signals to a KYC request.",
        )

    if not public_signals_match_request(
        payload.publicSignals,
        created_at_ms=ctx.createdAt,
        checks=ctx.checks,
        constraints=ctx.constraints,
    ):
        return VerifyProofResponse(
            verified=False,
            message="Public signals do not match the stated KYC request constraints.",
        )

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        proof_path = temp_path / "proof.json"
        public_signals_path = temp_path / "publicSignals.json"
        proof_path.write_text(
            json.dumps(payload.proof),
            encoding="utf-8",
        )
        public_signals_path.write_text(
            json.dumps(payload.publicSignals),
            encoding="utf-8",
        )
        command = _snarkjs_verify_command(
            FLEXIBLE_KYC_VKEY_PATH,
            public_signals_path,
            proof_path,
        )
        if command is None:
            return VerifyProofResponse(
                verified=False,
                message=(
                    "snarkjs executable not found. Run `npm install` at repo root "
                    "or install Node.js so `npx` is available in PATH."
                ),
            )
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                cwd=str(PROJECT_ROOT),
                timeout=90,
            )
        except FileNotFoundError:
            return VerifyProofResponse(
                verified=False,
                message=(
                    "snarkjs command could not be launched from backend process. "
                    "Ensure Node.js/npm is installed and restart uvicorn from a shell where `npx` works."
                ),
            )
        except subprocess.TimeoutExpired:
            _logger.error("verify-proof: groth16 verification subprocess timed out")
            return VerifyProofResponse(
                verified=False,
                message=(
                    "Groth16 verification timed out on the backend. "
                    "Try again and check server load/artifacts."
                ),
            )

    if result.returncode != 0:
        return VerifyProofResponse(
            verified=False,
            message=result.stderr.strip()
            or result.stdout.strip()
            or "Groth16 verification failed.",
        )

    stdout = (result.stdout or "").strip()
    ok = "OK!" in stdout
    return VerifyProofResponse(
        verified=ok,
        message="ZK proof verified."
        if ok
        else "ZK proof is invalid.",
    )
