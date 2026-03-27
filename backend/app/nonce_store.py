from __future__ import annotations

import logging
import time
from typing import Optional

import redis

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_memory_used: dict[str, float | None] = {}
_warned_redis_unavailable = False


def _redis_client() -> redis.Redis:
    # decode_responses=True keeps returned values as str instead of bytes.
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def try_mark_nonce_used(nonce: str, *, ttl_seconds: Optional[int] = None) -> bool:
    """
    Atomically mark a nonce as used.

    Returns:
      - True if this nonce was not used before (and is now marked used)
      - False if the nonce already exists (replay detected)

    Raises:
      - redis.RedisError on infrastructure failures.
    """
    if not nonce:
        # Treat missing nonce as "not enforceable" (caller can decide policy).
        return False

    key = f"used_nonces:{nonce}"
    value = "1"
    client = _redis_client()

    # Redis SET with NX is atomic: it will only set the key if it does not exist.
    try:
        client = _redis_client()
        if ttl_seconds is not None:
            res = client.set(key, value, nx=True, ex=ttl_seconds)
        else:
            res = client.set(key, value, nx=True)
        return bool(res)
    except redis.RedisError:
        # Dev/ops safety: if Redis is down, do not hard-fail proof verification.
        # We fall back to an in-memory replay cache (non-distributed).
        global _warned_redis_unavailable
        if not _warned_redis_unavailable:
            _warned_redis_unavailable = True
            logger.warning(
                "Redis unavailable (%s). Falling back to in-memory nonce replay protection.",
                settings.redis_url,
            )

        now = time.time()
        expiry = float("inf") if ttl_seconds is None else now + float(ttl_seconds)

        prev_expiry = _memory_used.get(key)
        if prev_expiry is None:
            _memory_used[key] = expiry
            return True
        if prev_expiry is not None and prev_expiry < now:
            # expired -> treat as fresh
            _memory_used.pop(key, None)
            _memory_used[key] = expiry
            return True

        return False

