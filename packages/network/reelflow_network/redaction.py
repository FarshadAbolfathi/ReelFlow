"""Secret redaction for logs and error messages. Mirrors packages/logger (TS)."""

from __future__ import annotations

import re
from typing import Any

MASK = "********"

SECRET_KEYS = {
    "password",
    "passwd",
    "token",
    "access_token",
    "accesstoken",
    "refresh_token",
    "authorization",
    "cookie",
    "set-cookie",
    "secret",
    "client_secret",
    "api_key",
    "apikey",
    "proxy_password",
    "session",
    "session_secret",
    "encryption_key",
    "uuid",  # VLESS user id in sing-box configs is a credential
    "private_key",
    "public_key",
    "short_id",
}

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"((?:access_token|token|password|secret|client_secret|api_key|sig|proxy_password)=)[^&\s\"']+", re.I), r"\1" + MASK),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/-]+=*"), r"\1" + MASK),
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@", re.I), r"\1" + MASK + "@"),
    # vless://<uuid>@host share links
    (re.compile(r"(vless://)[^@\s]+@", re.I), r"\1" + MASK + "@"),
]


def redact_string(value: str) -> str:
    out = value
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out


def redact(value: Any) -> Any:
    """Recursively redacts dict keys that look secret and secret patterns in strings."""
    if isinstance(value, dict):
        return {k: (MASK if str(k).lower() in SECRET_KEYS else redact(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return type(value)(redact(v) for v in value)
    if isinstance(value, str):
        return redact_string(value)
    return value


def structlog_redactor(_logger: Any, _method: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """structlog processor: redact every event before it is rendered."""
    return redact(event_dict)
