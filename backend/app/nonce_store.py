from __future__ import annotations

import hashlib
from typing import Optional

import redis

from app.config import get_settings

settings = get_settings()


def _redis_client() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def try_mark_nonce_used(nonce: str, *, ttl_seconds: Optional[int] = None) -> bool:
    """
    Atomically mark a nonce as used in shared Redis storage.

    Returns True only for the first successful SET NX. Returns False when the
    nonce has already been consumed. Redis errors deliberately propagate so
    the API can fail closed instead of silently using per-process memory.
    """
    if not nonce:
        return False

    # Store only a digest; the original request nonce is never used as a key.
    digest = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
    key = f"used_nonces:{digest}"
    client = _redis_client()

    if ttl_seconds is not None:
        result = client.set(key, "1", nx=True, ex=ttl_seconds)
    else:
        result = client.set(key, "1", nx=True)

    return bool(result)
