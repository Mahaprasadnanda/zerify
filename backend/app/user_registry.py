from __future__ import annotations

import json
from typing import Any
from urllib import error, parse, request

from app.config import get_settings

settings = get_settings()


class UserRegistryError(RuntimeError):
    pass


def phone_digits(phone_e164: str) -> str:
    return "".join(ch for ch in phone_e164 if ch.isdigit())


def _recipient_profile_url(phone_e164: str) -> str:
    database_url = settings.firebase_database_url.rstrip("/")
    base_path = settings.firebase_recipient_profiles_path.strip("/")
    quoted_path = parse.quote(f"{base_path}/{phone_digits(phone_e164)}", safe="/")
    url = f"{database_url}/{quoted_path}.json"

    if settings.firebase_database_secret:
        return f"{url}?auth={parse.quote(settings.firebase_database_secret, safe='')}"

    return url


def _firebase_request(url: str, *, method: str, payload: dict[str, Any] | None = None) -> Any:
    body = None
    headers = {"Content-Type": "application/json"}

    if payload is not None:
        body = json.dumps(payload).encode("utf-8")

    req = request.Request(url, data=body, headers=headers, method=method)

    try:
        with request.urlopen(req, timeout=10) as response:
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise UserRegistryError(
            f"Firebase user registry request failed with status {exc.code}: {detail or exc.reason}"
        ) from exc
    except error.URLError as exc:
        raise UserRegistryError(f"Firebase user registry unavailable: {exc.reason}") from exc


def mark_user_registered(phone_e164: str, *, registered_at: int) -> dict[str, Any]:
    payload = {
        "phoneE164": phone_e164,
        "phoneDigits": phone_digits(phone_e164),
        "selfRegisteredAt": registered_at,
        "updatedAt": registered_at,
    }
    _firebase_request(_recipient_profile_url(phone_e164), method="PATCH", payload=payload)
    return payload


def get_user_profile(phone_e164: str) -> dict[str, Any]:
    profile = _firebase_request(_recipient_profile_url(phone_e164), method="GET")
    if isinstance(profile, dict):
        return profile
    return {}


def is_user_registered(phone_e164: str) -> bool:
    profile = get_user_profile(phone_e164)
    return bool(profile.get("selfRegisteredAt"))
