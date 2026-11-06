import hashlib

import redis
import pytest

from app import nonce_store


class FakeRedis:
    def __init__(self):
        self.values = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return None
        self.values[key] = value
        return True


def test_nonce_is_hashed_and_only_marked_once(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(nonce_store, "_redis_client", lambda: fake)

    nonce = "resume-demo-nonce"
    expected_key = "used_nonces:" + hashlib.sha256(nonce.encode()).hexdigest()

    assert nonce_store.try_mark_nonce_used(nonce) is True
    assert nonce_store.try_mark_nonce_used(nonce) is False
    assert list(fake.values) == [expected_key]


def test_empty_nonce_is_rejected():
    assert nonce_store.try_mark_nonce_used("") is False


def test_redis_failure_propagates_instead_of_using_local_memory(monkeypatch):
    def unavailable():
        raise redis.ConnectionError("Redis unavailable")

    monkeypatch.setattr(nonce_store, "_redis_client", unavailable)

    with pytest.raises(redis.RedisError):
        nonce_store.try_mark_nonce_used("cannot-be-accepted-without-shared-store")
