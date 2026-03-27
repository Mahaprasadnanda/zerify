"""
Groth16 proof verifier.

Runs snark_verifier.js (Node.js) as a subprocess and parses structured JSON.
Never raises on proof invalidity — only raises on infrastructure failures.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Resolved paths
# ---------------------------------------------------------------------------

_BACKEND_DIR: Path = Path(__file__).resolve().parent.parent
_WRAPPER: Path = _BACKEND_DIR / "snark_verifier.js"
_VK_PATH: Path = Path(__file__).resolve().parent / "flexible_kyc_verification_key.json"


def _find_node() -> str:
    """Return the path to the node binary or raise EnvironmentError."""
    for candidate in ("node", "node.exe"):
        found = shutil.which(candidate)
        if found:
            return found
    raise EnvironmentError(
        "Node.js binary not found in PATH. "
        "Install Node.js (https://nodejs.org) and ensure it is on PATH."
    )


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class VerificationResult:
    valid: bool
    error: Optional[str] = None
    raw_output: str = field(default="", repr=False)

    @property
    def ok(self) -> bool:
        """True only when the verifier ran cleanly AND the proof is valid."""
        return self.valid and self.error is None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def verify_groth16(
    proof: dict,
    public_signals: list,
    *,
    vkey_path: Path | None = None,
    timeout_seconds: int = 90,
) -> VerificationResult:
    """
    Verify a Groth16 proof using snarkjs (via snark_verifier.js subprocess).

    Parameters
    ----------
    proof : dict
        The proof object received from the client.
    public_signals : list[str]
        The public signals list received from the client.
    vkey_path : Path | None
        Verification key JSON. Defaults to flexible_kyc_verification_key.json next to this module.
    timeout_seconds : int
        Hard kill timeout for the Node subprocess (default 90s).

    Returns
    -------
    VerificationResult
        .valid is True only if the proof checks out.
        .error is None on a clean run, or a string if snarkjs threw internally.

    Raises
    ------
    EnvironmentError
        Node.js binary not found in PATH.
    FileNotFoundError
        snark_verifier.js or the verification key JSON is missing.
    subprocess.TimeoutExpired
        Node subprocess exceeded timeout_seconds.
    RuntimeError
        Node subprocess crashed (non-zero exit, empty stdout) OR returned
        output that is not valid JSON.
    """
    node_bin = _find_node()

    if not _WRAPPER.exists():
        raise FileNotFoundError(
            f"snark_verifier.js not found at {_WRAPPER}. "
            "Ensure the file was created in backend/."
        )

    vk_path = vkey_path if vkey_path is not None else _VK_PATH
    if not vk_path.exists():
        raise FileNotFoundError(
            f"Verification key not found at {vk_path}. "
            "Copy flexible_kyc_verification_key.json (and commitment key if needed) to backend/app/."
        )

    with tempfile.TemporaryDirectory(prefix="zerify_verify_") as tmp:
        pub_path = Path(tmp) / "public.json"
        proof_path = Path(tmp) / "proof.json"

        pub_path.write_text(json.dumps(public_signals), encoding="utf-8")
        proof_path.write_text(json.dumps(proof), encoding="utf-8")

        try:
            proc = subprocess.run(
                [
                    node_bin,
                    str(_WRAPPER),
                    str(vk_path.resolve()),
                    str(pub_path),
                    str(proof_path),
                ],
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                shell=False,
            )
        except subprocess.TimeoutExpired:
            raise

        raw = proc.stdout.strip()

        if proc.returncode != 0 and not raw:
            raise RuntimeError(
                f"snark_verifier.js crashed (exit {proc.returncode}). "
                f"stderr: {proc.stderr.strip()!r}"
            )

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"snark_verifier.js produced non-JSON output: {raw!r}. "
                f"stderr: {proc.stderr.strip()!r}"
            ) from exc

        return VerificationResult(
            valid=bool(payload.get("valid", False)),
            error=payload.get("error"),
            raw_output=raw,
        )
