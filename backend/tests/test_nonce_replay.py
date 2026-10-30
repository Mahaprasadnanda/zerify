import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.verifier import VerificationResult


def make_payload(nonce: str):
    return {
        "proof": {"dummy": True},
        "publicSignals": ["0"] * 16,
        "nonce": nonce,
        "scheme": "groth16-flexible-kyc",
        "requestContext": {
            "createdAt": 1781481600000,
            "checks": ["age"],
            "constraints": {"minAge": 18},
            "security": {"nonce": nonce, "requireCommitment": False},
        },
    }


@pytest.mark.parametrize("fresh", [True, False])
def test_nonce_replay_enforcement(fresh):
    """
    Replay protection:
      - if nonce is fresh => endpoint returns verified: true (given a valid proof)
      - if nonce was used => endpoint returns verified: false
    """
    client = TestClient(app)
    nonce = "test-nonce-123"

    with (
        pytest.MonkeyPatch.context() as mp,
    ):
        # Force all other checks to pass.
        mp.setattr("app.main.public_signals_match_request", lambda *args, **kwargs: True)
        mp.setattr(
            "app.main.verify_groth16",
            lambda *args, **kwargs: VerificationResult(valid=True, error=None),
        )
        mp.setattr(
            "app.main.try_mark_nonce_used",
            lambda _nonce: fresh,
        )

        res = client.post("/api/verify-proof", json=make_payload(nonce))
        assert res.status_code == 200
        body = res.json()

        if fresh:
            assert body["verified"] is True
        else:
            assert body["verified"] is False
            assert "Nonce already used" in body["message"]


def test_missing_nonce_is_rejected():
    client = TestClient(app)
    payload = make_payload("test-nonce-123")
    payload["requestContext"]["security"] = {}

    res = client.post("/api/verify-proof", json=payload)

    assert res.status_code == 200
    assert res.json() == {
        "verified": False,
        "message": "Missing request nonce",
    }
