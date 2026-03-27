"""Encode expected flexible KYC public signals — must match frontend/utils/flexibleKycWitness.ts."""

from __future__ import annotations

from datetime import datetime, timezone

import base64

FLEXIBLE_KYC_PUBLIC_SIGNAL_COUNT = 17


def kyc_anchor_year_utc(created_at_ms: int) -> int:
    return datetime.fromtimestamp(created_at_ms / 1000.0, tz=timezone.utc).year


def _digits_pin(pc: str) -> str:
    d = "".join(c for c in pc if c.isdigit())[:6]
    return d


def _gender_label_to_code(label: str) -> int:
    if label == "Male":
        return 1
    if label == "Female":
        return 2
    if label == "Other":
        return 3
    return 0


def _nonce_base64url_to_field_element_str(nonce: str | None) -> str:
    """
    Convert request nonce (base64url random bytes) to a decimal string field element.

    The circuit expects a numeric `signal input nonce;`. Our nonce is 16 bytes (128-bit),
    which fits well under the BN128 field modulus, so we do not need reduction.
    """
    if not nonce:
        return "0"

    # base64url -> standard base64
    b64 = nonce.replace("-", "+").replace("_", "/")
    pad_len = (4 - (len(b64) % 4)) % 4
    b64 = b64 + ("=" * pad_len)
    raw = base64.b64decode(b64)
    v = int.from_bytes(raw, byteorder="big", signed=False)
    return str(v)


def encode_expected_public_signals(
    *,
    created_at_ms: int,
    checks: list[str],
    constraints: dict,
    nonce: str | None = None,
) -> list[str]:
    current_year = kyc_anchor_year_utc(created_at_ms)
    """Return the 17 public signal strings snarkjs should output for this request."""
    check_age = 1 if "age" in checks else 0
    check_gender = 1 if "gender" in checks else 0
    check_address = 1 if "address" in checks else 0

    min_age = max(0, int(constraints.get("minAge", 0))) if check_age else 0
    req_g = str(constraints.get("requiredGender") or "")
    required_gender = _gender_label_to_code(req_g) if check_gender else 0

    slots = [0, 0, 0, 0, 0]
    uses = [0, 0, 0, 0, 0]
    if check_address:
        raw_pins = constraints.get("pincodes") or []
        plist = [_digits_pin(str(p)) for p in raw_pins]
        plist = [p for p in plist if len(p) == 6][:5]
        for i, p in enumerate(plist):
            slots[i] = int(p)
            uses[i] = 1

    def s(n: int) -> str:
        return str(n)

    nonce_fe = _nonce_base64url_to_field_element_str(nonce)

    return [
        s(current_year),
        s(min_age),
        s(required_gender),
        s(slots[0]),
        s(slots[1]),
        s(slots[2]),
        s(slots[3]),
        s(slots[4]),
        s(uses[0]),
        s(uses[1]),
        s(uses[2]),
        s(uses[3]),
        s(uses[4]),
        s(check_age),
        s(check_gender),
        s(check_address),
        nonce_fe,
    ]


def public_signals_match_request(
    public_signals: list[str],
    *,
    created_at_ms: int,
    checks: list[str],
    constraints: dict,
    nonce: str | None = None,
) -> bool:
    if len(public_signals) < FLEXIBLE_KYC_PUBLIC_SIGNAL_COUNT:
        return False
    expected = encode_expected_public_signals(
        created_at_ms=created_at_ms,
        checks=checks,
        constraints=constraints,
        nonce=nonce,
    )
    return public_signals[:FLEXIBLE_KYC_PUBLIC_SIGNAL_COUNT] == expected
