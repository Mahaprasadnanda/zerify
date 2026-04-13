from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent


class Settings(BaseSettings):
    app_name: str = "privacy-preserving-kyc-backend"
    app_env: str = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    redis_url: str = "redis://localhost:6379/0"
    firebase_database_url: str = "https://zerify-a8c25-default-rtdb.asia-southeast1.firebasedatabase.app"
    firebase_database_secret: str = ""
    firebase_recipient_profiles_path: str = "recipientProfiles"
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_service_sid: str = ""
    twilio_verify_service_sid: str = ""
    twilio_sms_from: str = ""
    twilio_sms_messaging_service_sid: str = ""

    model_config = SettingsConfigDict(
        env_file=(
            str(_BACKEND_DIR / ".env"),
            str(_REPO_ROOT / ".env"),
        ),
        env_file_encoding="utf-8",
        case_sensitive=False,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
