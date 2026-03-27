"""
Unit tests for app/verifier.py.

These tests mock subprocess.run so they do NOT require Node.js to be
installed or snarkjs to be available.
"""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.verifier import verify_groth16

DUMMY_PROOF = {
    "pi_a": ["1", "2", "1"],
    "pi_b": [["1", "2"], ["3", "4"], ["1", "0"]],
    "pi_c": ["1", "2", "1"],
    "protocol": "groth16",
    "curve": "bn128",
}

DUMMY_SIGNALS = [
    "2026",
    "18",
    "1",
    "754109",
    "0",
    "0",
    "0",
    "0",
    "1",
    "0",
    "0",
    "0",
    "0",
    "1",
    "1",
    "1",
]


def make_proc(stdout: str, returncode: int = 0, stderr: str = "") -> MagicMock:
    m = MagicMock()
    m.stdout = stdout
    m.returncode = returncode
    m.stderr = stderr
    return m


def _mock_path_exists() -> tuple[MagicMock, MagicMock]:
    """Mocks for _WRAPPER and _VK_PATH with exists() = True."""
    mock_wr = MagicMock()
    mock_wr.exists.return_value = True
    mock_vk = MagicMock()
    mock_vk.exists.return_value = True
    mock_vk.resolve.return_value = Path("/fake/vk.json")
    return mock_wr, mock_vk


def infra_patches(f):
    mock_wr, mock_vk = _mock_path_exists()
    patches = [
        patch("app.verifier._find_node", return_value="/usr/bin/node"),
        patch("app.verifier._WRAPPER", mock_wr),
        patch("app.verifier._VK_PATH", mock_vk),
    ]
    for p in reversed(patches):
        f = p(f)
    return f


@infra_patches
@patch("app.verifier.subprocess.run")
def test_valid_proof_returns_ok(mock_run, *_):
    mock_run.return_value = make_proc(json.dumps({"valid": True, "error": None}))
    result = verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)
    assert result.valid is True
    assert result.error is None
    assert result.ok is True


@infra_patches
@patch("app.verifier.subprocess.run")
def test_invalid_proof_returns_not_ok(mock_run, *_):
    mock_run.return_value = make_proc(json.dumps({"valid": False, "error": None}))
    result = verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)
    assert result.valid is False
    assert result.error is None
    assert result.ok is False


@infra_patches
@patch("app.verifier.subprocess.run")
def test_verifier_level_error_is_surfaced(mock_run, *_):
    mock_run.return_value = make_proc(
        json.dumps({"valid": False, "error": "verify_threw: curve mismatch"})
    )
    result = verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)
    assert result.valid is False
    assert result.error is not None
    assert "curve mismatch" in result.error


@infra_patches
@patch("app.verifier.subprocess.run")
def test_garbage_stdout_raises_runtime_error(mock_run, *_):
    mock_run.return_value = make_proc("snarkJS: OK!", returncode=0)
    with pytest.raises(RuntimeError, match="non-JSON output"):
        verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)


@infra_patches
@patch("app.verifier.subprocess.run")
def test_empty_stdout_nonzero_exit_raises_runtime_error(mock_run, *_):
    mock_run.return_value = make_proc("", returncode=1, stderr="Segfault")
    with pytest.raises(RuntimeError, match="crashed"):
        verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)


@infra_patches
@patch("app.verifier.subprocess.run")
def test_timeout_re_raised(mock_run, *_):
    mock_run.side_effect = subprocess.TimeoutExpired(cmd="node", timeout=90)
    with pytest.raises(subprocess.TimeoutExpired):
        verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)


def test_node_not_found_raises_environment_error():
    with patch("app.verifier.shutil.which", return_value=None):
        with pytest.raises(EnvironmentError, match="Node.js binary not found"):
            verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)


def test_vk_missing_raises_file_not_found(tmp_path):
    mock_wr = MagicMock()
    mock_wr.exists.return_value = True
    fake_vk = tmp_path / "missing.json"
    with (
        patch("app.verifier._find_node", return_value="/usr/bin/node"),
        patch("app.verifier._WRAPPER", mock_wr),
        patch("app.verifier._VK_PATH", fake_vk),
    ):
        with pytest.raises(FileNotFoundError, match="Verification key"):
            verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)


def test_wrapper_missing_raises_file_not_found(tmp_path):
    fake_wrapper = tmp_path / "snark_verifier.js"
    fake_vk = tmp_path / "vk.json"
    fake_vk.write_text("{}", encoding="utf-8")
    with (
        patch("app.verifier._find_node", return_value="/usr/bin/node"),
        patch("app.verifier._WRAPPER", fake_wrapper),
        patch("app.verifier._VK_PATH", fake_vk),
    ):
        with pytest.raises(FileNotFoundError, match="snark_verifier.js not found"):
            verify_groth16(DUMMY_PROOF, DUMMY_SIGNALS)
