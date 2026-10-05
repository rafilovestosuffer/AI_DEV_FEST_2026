"""One settings module: the only place environment variables are read.

Every secret arrives here from the host environment (or a local .env, which
is git-ignored). Defaults are safe for local development only — AUTH_SECRET
must be set in any deployed environment; the model_validator below refuses
to boot in production while it is still the dev default.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Development-only placeholder. Never a valid production secret.
_DEV_AUTH_SECRET = "dev-only-not-a-secret-change-me-32b"
_PROD_ENVS = ("prod", "production")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "dev"
    database_url: str = "sqlite:///./data/sathi.db"
    auth_secret: str = _DEV_AUTH_SECRET
    # Comma-separated. The Capacitor origin (https://localhost) and the local
    # dev origin are always allowed (architecture §5 / ADR-04).
    allowed_origins: str = ""
    llm_provider: str = "openai-compatible"  # "none" | "openai-compatible" | "openrouter"
    llm_api_key: str = ""
    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_model: str = "openrouter/auto"
    llm_enabled: bool = False           # kill switch (P0)
    llm_daily_cap: int = 200
    git_commit: str = "unknown"
    token_ttl_minutes: int = 120        # short-lived demo JWT

    @model_validator(mode="after")
    def _reject_dev_auth_secret_in_prod(self) -> Settings:
        """Boot guard: production must not run on the committed dev secret.

        Raises RuntimeError (not a validation error) so the failure is an
        unmistakable startup abort, not a per-field form error. Development
        (app_env=dev or anything non-prod) is unaffected.
        """
        if self.app_env.strip().lower() in _PROD_ENVS and self.auth_secret == _DEV_AUTH_SECRET:
            raise RuntimeError(
                "AUTH_SECRET is still the development default but APP_ENV="
                f"{self.app_env!r}. Set a real AUTH_SECRET (32+ random bytes) "
                "before starting in production."
            )
        return self

    @property
    def cors_origins(self) -> list[str]:
        origins = {"https://localhost", "http://localhost:3000", "http://127.0.0.1:3000"}
        for o in self.allowed_origins.split(","):
            o = o.strip()
            if o:
                origins.add(o)
        return sorted(origins)


@lru_cache
def get_settings() -> Settings:
    return Settings()
