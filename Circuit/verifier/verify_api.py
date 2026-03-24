# Demo-only: the Zerify monorepo verifies proofs in backend/app/main.py (POST /verify-proof).
from fastapi import FastAPI
from pydantic import BaseModel
import subprocess
import json
import os

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ============================
# REQUEST FORMAT
# ============================
class ProofRequest(BaseModel):
    proof: dict
    publicSignals: list


# ============================
# VERIFY ENDPOINT
# ============================
@app.post("/verify-proof")
def verify_proof(req: ProofRequest):

    try:
        proof_path = os.path.join(BASE_DIR, "uploaded_proof.json")
        public_path = os.path.join(BASE_DIR, "uploaded_public.json")
        vkey_path = os.path.join(BASE_DIR, "../vkey/flexible_kyc_verification_key.json")

        # Save incoming proof
        with open(proof_path, "w") as f:
            json.dump(req.proof, f)

        with open(public_path, "w") as f:
            json.dump(req.publicSignals, f)

        # Run snarkjs verification
        command = f'npx snarkjs groth16 verify "{vkey_path}" "{public_path}" "{proof_path}"'

        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True
        )

        print("STDOUT:", result.stdout)
        print("STDERR:", result.stderr)

        if "OK!" in result.stdout:
            return {
                "status": "valid",
                "message": "KYC verification successful"
            }
        else:
            return {
                "status": "invalid",
                "message": "KYC verification failed"
            }

    except Exception as e:
        return {
            "status": "error",
            "message": str(e)
        }