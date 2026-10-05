"""In-memory sliding-window rate limiter for the public prototype endpoints.

Limits are read from config/app.yaml `rate_limits` (window_s, chat_per_window,
parse_amount_per_window, demo_login_per_window) — never hardcoded (invariant
14). Each (endpoint-class, caller) pair owns a deque of allowed-request
timestamps; timestamps older than window_s are purged on every hit, so the
counter is a true sliding window, not a fixed one.

Callers are keyed by the verified token subject (`user:<id>`) when a valid
bearer token is presented, else by client IP (`ip:<addr>`).

Single instance only, reset on redeploy (docs/risks.md); the limiter state is
process-local memory. Enforcement raises `RateLimitedError`, which the app's
SathiError handler maps to the stable error schema (HTTP 429).
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import Request

import sathi_config
from api.auth import decode_access_token
from api.errors import RateLimitedError, SathiError

# Endpoint class -> config key carrying its per-window limit.
_ENDPOINT_LIMIT_KEYS = {
    "chat": "chat_per_window",
    "parse_amount": "parse_amount_per_window",
    "demo_login": "demo_login_per_window",
}


class SlidingWindowLimiter:
    """Thread-safe sliding-window counter.

    `allow(bucket, key)` records a request when it is inside the configured
    limit and returns True; a denied request is NOT recorded, so rejected
    retries never extend the penalty beyond the last allowed request.
    """

    def __init__(self, window_s: float, limits: dict[str, int]):
        self.window_s = float(window_s)
        self.limits = {bucket: int(v) for bucket, v in limits.items()}
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, bucket: str, key: str, now: float | None = None) -> bool:
        """Purge timestamps outside the window, then judge this request."""
        limit = self.limits.get(bucket)
        if limit is None or limit <= 0:
            return True  # nothing configured for this bucket: unbounded
        t = time.monotonic() if now is None else float(now)
        cutoff = t - self.window_s
        with self._lock:
            hits = self._hits[(bucket, key)]
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= limit:
                return False
            hits.append(t)
            return True

    def reset(self) -> None:
        """Forget every recorded hit (used by tests and redeploy-equivalents)."""
        with self._lock:
            self._hits.clear()


_limiter: SlidingWindowLimiter | None = None
_limiter_lock = threading.Lock()


def get_limiter() -> SlidingWindowLimiter:
    """The process-wide limiter, built once from config/app.yaml `rate_limits`."""
    global _limiter
    with _limiter_lock:
        if _limiter is None:
            rl = sathi_config.load_config().section("rate_limits")
            _limiter = SlidingWindowLimiter(
                window_s=rl["window_s"],
                limits={bucket: rl[key] for bucket, key in _ENDPOINT_LIMIT_KEYS.items()},
            )
        return _limiter


def caller_key(request: Request) -> str:
    """Verified token subject when available, else the client IP.

    A token that fails verification falls back to IP keying — authentication
    itself still rejects it; the limiter only decides the bucket identity.
    """
    auth = request.headers.get("authorization", "")
    parts = auth.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        try:
            sub = decode_access_token(parts[1]).get("sub")
        except SathiError:
            sub = None
        if sub:
            return f"user:{sub}"
    host = request.client.host if request.client else "unknown"
    return f"ip:{host}"


def rate_limit(bucket: str):
    """FastAPI dependency factory: enforce `bucket`'s sliding-window limit.

    Raise the dependency BEFORE authentication dependencies in the route
    signature so a flood of bad-token requests is still throttled.
    """
    async def _check(request: Request) -> None:
        if not get_limiter().allow(bucket, caller_key(request)):
            raise RateLimitedError()

    return _check
