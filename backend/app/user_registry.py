from __future__ import annotations

import logging
import time

import redis

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_memory_registered: dict[str, int] = {}
_warned_redis_unavailable = False


def _redis_client() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def _user_key(phone_e164: str) -> str:
    return f"registered_users:{phone_e164}"


def mark_user_registered(phone_e164: str) -> int:
    registered_at = int(time.time() * 1000)
    key = _user_key(phone_e164)

    try:
        _redis_client().set(key, str(registered_at))
        return registered_at
    except redis.RedisError:
        global _warned_redis_unavailable
        if not _warned_redis_unavailable:
            _warned_redis_unavailable = True
            logger.warning(
                "Redis unavailable (%s). Falling back to in-memory user registry.",
                settings.redis_url,
            )

        _memory_registered[key] = registered_at
        return registered_at


def is_user_registered(phone_e164: str) -> bool:
    key = _user_key(phone_e164)

    try:
        return bool(_redis_client().exists(key))
    except redis.RedisError:
        return key in _memory_registered
