"""Process-scoped networking for ReelFlow. Never modifies machine-wide settings."""

from .client import DownloadResult, MediaTooLargeError, NetworkClient, NetworkUnavailableError, SourceUnavailableError
from .process_runner import FORBIDDEN_PROGRAMS, ForbiddenCommandError, ProcessRunner, assert_allowed
from .proxy_config import NetworkMode, ProxyConfig, ProxyScheme, check_singbox_config, validate_project, validate_runtime
from .proxy_health import Health, HealthResult, check_proxy
from .proxy_manager import Ownership, ProxyManager, ProxyStartError, ProxyStatus
from .redaction import redact, redact_string, structlog_redactor
from .ssrf import UrlBlockedError, assert_public_destination, is_blocked_ip, normalize_url, validate_public_url


def client_for(mode: NetworkMode, manager: ProxyManager | None, **kwargs) -> NetworkClient:
    """The one way to build a client for a job: its declared mode, nothing inherited."""
    if mode is NetworkMode.PROXY:
        if manager is None:
            raise NetworkUnavailableError("PROXY mode requested but no proxy manager configured")
        return NetworkClient(mode, proxy_url=manager.get_proxy_url(), health_check=manager.health_check, **kwargs)
    return NetworkClient(NetworkMode.DIRECT, **kwargs)


__all__ = [
    "FORBIDDEN_PROGRAMS",
    "DownloadResult",
    "ForbiddenCommandError",
    "Health",
    "HealthResult",
    "MediaTooLargeError",
    "NetworkClient",
    "NetworkMode",
    "NetworkUnavailableError",
    "Ownership",
    "ProcessRunner",
    "ProxyConfig",
    "ProxyManager",
    "ProxyScheme",
    "ProxyStartError",
    "ProxyStatus",
    "SourceUnavailableError",
    "UrlBlockedError",
    "assert_allowed",
    "assert_public_destination",
    "check_proxy",
    "check_singbox_config",
    "client_for",
    "is_blocked_ip",
    "normalize_url",
    "redact",
    "redact_string",
    "structlog_redactor",
    "validate_project",
    "validate_public_url",
    "validate_runtime",
]
