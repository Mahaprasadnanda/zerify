from typing import Any

from pydantic import BaseModel, Field


class KycProofRequestContext(BaseModel):
    """Subset of the Firebase KYC request used to bind public signals (no PII)."""

    createdAt: int = Field(
        ...,
        description="kycRequests.createdAt (epoch ms); UTC year anchors current_year in the circuit.",
    )
    checks: list[str] = Field(
        default_factory=list,
        description="Request checks, e.g. age, gender, address.",
    )
    constraints: dict[str, Any] = Field(
        default_factory=dict,
        description="Verifier constraints: minAge, requiredGender, pincodes.",
    )
    security: dict[str, Any] = Field(
        default_factory=dict,
        description="Optional security policy (e.g. requireCommitment).",
    )


class VerifyProofRequest(BaseModel):
    proof: dict[str, Any] = Field(
        default_factory=dict,
        description="Zero-knowledge proof object generated in the browser.",
    )
    publicSignals: list[str] = Field(
        default_factory=list,
        description="Public signals derived from the circuit.",
    )
    requestContext: KycProofRequestContext | None = Field(
        default=None,
        description="When set, public signals must match this request (anti-malicious prover).",
    )
    nonce: str | None = Field(
        default=None,
        description="Optional; unused for Groth16 verify.",
    )
    scheme: str | None = Field(
        default=None,
        description="Optional proof scheme/version hint (e.g. groth16-flexible-kyc-commitment).",
    )


class VerifyProofResponse(BaseModel):
    verified: bool
    message: str
