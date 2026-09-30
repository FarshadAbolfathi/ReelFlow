"""Proxy configuration, loaded from environment. Nothing here is hardcoded to one
machine: the defaults come from inspecting the local VPS Proxy setup
(see docs/VPS_PROXY_INTEGRATION.md) and every value can be overridden."""

from __future__ import annotations

import json
import os
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, Field


class NetworkMode(StrEnum):
    DIRECT = "DIRECT"
    PROXY = "PROXY"


class ProxyScheme(StrEnum):
    HTTP = "http"
    SOCKS5 = "socks5"


class ProxyConfig(BaseModel):
    mode: NetworkMode = NetworkMode.DIRECT
    provider: str = "vps-proxy"
    scheme: ProxyScheme = ProxyScheme.HTTP
    host: str = "127.0.0.1"
    port: int = Field(default=10808, ge=1, le=65535)
    health_url: str = "https://www.gstatic.com/generate_204"
    health_timeout_s: float = 20.0
    # The Flutter "VPS Proxy" app. Validated for reference only — never launched,
    # because its desktop backend changes the macOS system proxy.
    project_path: Path | None = None
    # The sing-box runtime that actually serves the local proxy.
    runtime_path: Path | None = None
    binary: str = "bin/sing-box"
    config_file: str = "config_proxy.json"
    managed_start: bool = False
    startup_timeout_s: float = 15.0

    @property
    def proxy_url(self) -> str:
        # socks5h → DNS is resolved on the proxy side (local DNS may be poisoned).
        scheme = "socks5h" if self.scheme is ProxyScheme.SOCKS5 else "http"
        return f"{scheme}://{self.host}:{self.port}"

    @property
    def address(self) -> str:
        return f"{self.host}:{self.port}"

    @property
    def binary_path(self) -> Path | None:
        return (self.runtime_path / self.binary) if self.runtime_path else None

    @property
    def config_path(self) -> Path | None:
        return (self.runtime_path / self.config_file) if self.runtime_path else None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "ProxyConfig":
        e = dict(os.environ if env is None else env)

        def path(key: str) -> Path | None:
            v = e.get(key, "").strip()
            return Path(v).expanduser() if v else None

        return cls(
            mode=NetworkMode.PROXY if e.get("NETWORK_MODE", "direct").lower() == "proxy" else NetworkMode.DIRECT,
            provider=e.get("PROXY_PROVIDER", "vps-proxy"),
            scheme=ProxyScheme(e.get("PROXY_SCHEME", "http").lower()),
            host=e.get("PROXY_HOST", "127.0.0.1"),
            port=int(e.get("PROXY_PORT", "10808")),
            health_url=e.get("PROXY_HEALTH_URL", "https://www.gstatic.com/generate_204"),
            health_timeout_s=float(e.get("PROXY_HEALTH_TIMEOUT_SECONDS", "20")),
            project_path=path("VPS_PROXY_PROJECT_PATH"),
            runtime_path=path("VPS_PROXY_RUNTIME_PATH"),
            binary=e.get("VPS_PROXY_BINARY", "bin/sing-box"),
            config_file=e.get("VPS_PROXY_CONFIG", "config_proxy.json"),
            managed_start=e.get("PROXY_MANAGED_START", "false").lower() in {"1", "true", "yes"},
        )


LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def validate_project(cfg: ProxyConfig) -> list[str]:
    """Checks the VPS Proxy project exists and looks like the expected Flutter app."""
    problems: list[str] = []
    p = cfg.project_path
    if p is None:
        return problems
    if not p.is_dir():
        return [f"VPS_PROXY_PROJECT_PATH does not exist: {p}"]
    for f in ("pubspec.yaml", "lib/vless_to_singbox.dart"):
        if not (p / f).is_file():
            problems.append(f"Expected file missing in VPS Proxy project: {f}")
    return problems


def validate_runtime(cfg: ProxyConfig) -> list[str]:
    """
    Validates the sing-box runtime WITHOUT modifying it:
      - binary exists and is executable
      - config parses
      - no `tun` inbound (would capture all system traffic)
      - no `set_system_proxy` (would change macOS proxy settings)
      - every inbound listens on loopback only
      - the configured port matches an inbound
    """
    problems: list[str] = []
    if cfg.runtime_path is None:
        return ["VPS_PROXY_RUNTIME_PATH is not set"]
    if not cfg.runtime_path.is_dir():
        return [f"VPS_PROXY_RUNTIME_PATH does not exist: {cfg.runtime_path}"]
    b = cfg.binary_path
    if b is None or not b.is_file() or not os.access(b, os.X_OK):
        problems.append(f"sing-box binary not found or not executable: {b}")
    c = cfg.config_path
    if c is None or not c.is_file():
        problems.append(f"Proxy config not found: {c}")
        return problems
    try:
        data = json.loads(c.read_text())
    except (OSError, json.JSONDecodeError) as e:
        return [*problems, f"Proxy config is not valid JSON: {e}"]
    return problems + check_singbox_config(data, cfg.port)


def check_singbox_config(data: dict, expected_port: int) -> list[str]:
    problems: list[str] = []
    inbounds = data.get("inbounds") or []
    if not inbounds:
        problems.append("Proxy config has no inbounds")
    ports = set()
    for ib in inbounds:
        kind = str(ib.get("type", ""))
        if kind == "tun":
            problems.append("Proxy config contains a TUN inbound (system-wide routing) — refused")
        if ib.get("set_system_proxy"):
            problems.append("Proxy config enables set_system_proxy (changes macOS settings) — refused")
        listen = str(ib.get("listen", ""))
        if listen not in LOOPBACK:
            problems.append(f"Inbound '{ib.get('tag', kind)}' listens on {listen or 'all interfaces'} — must be loopback")
        if kind in {"mixed", "http", "socks"}:
            ports.add(int(ib.get("listen_port", 0)))
    if inbounds and expected_port not in ports:
        problems.append(f"No mixed/http/socks inbound on port {expected_port} (found {sorted(ports)})")
    return problems
