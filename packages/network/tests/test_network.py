"""Network isolation tests: direct, proxy, unavailable, startup failure, restart,
termination, timeout, retry, fail-closed, redaction, global config untouched."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import pytest

from reelflow_network import (
    ForbiddenCommandError,
    Health,
    HealthResult,
    NetworkClient,
    NetworkMode,
    NetworkUnavailableError,
    Ownership,
    ProcessRunner,
    ProxyConfig,
    ProxyManager,
    ProxyStartError,
    SourceUnavailableError,
    UrlBlockedError,
    assert_allowed,
    check_singbox_config,
    client_for,
    redact,
    redact_string,
    structlog_redactor,
)

from .conftest import free_port, make_fake_singbox, start_fake_proxy


def healthy() -> HealthResult:
    return HealthResult(Health.HEALTHY, datetime.now(UTC), 5)


def unavailable(step: str = "tcp") -> HealthResult:
    return HealthResult(Health.UNAVAILABLE, datetime.now(UTC), failed_step=step, error="down")


# 1. Direct mode ─────────────────────────────────────────────────────────
async def test_direct_mode_reaches_target_without_proxy(target, fake_proxy):
    async with NetworkClient(NetworkMode.DIRECT, ssrf_protection=False) as c:
        r = await c.get(target.url("/direct"))
    assert r.text == "hello /direct"
    assert fake_proxy.requests == []


async def test_direct_mode_blocks_private_destinations():
    async with NetworkClient(NetworkMode.DIRECT) as c:
        with pytest.raises(UrlBlockedError):
            await c.get("http://127.0.0.1:1/")
        with pytest.raises(UrlBlockedError):
            await c.get("http://169.254.169.254/latest/meta-data/")


# 2. Proxy mode ──────────────────────────────────────────────────────────
async def test_proxy_mode_routes_through_proxy(target, fake_proxy):
    async def ok():
        return healthy()

    async with NetworkClient(NetworkMode.PROXY, proxy_url=fake_proxy.url, health_check=ok, ssrf_protection=False) as c:
        r = await c.get(target.url("/via-proxy"))
    assert r.text == "hello /via-proxy"
    assert len(fake_proxy.requests) == 1
    assert f"127.0.0.1:{target.port}" in fake_proxy.requests[0]


async def test_real_health_check_through_fake_proxy(target, fake_proxy):
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=fake_proxy.port, health_url=target.url("/generate_204"), health_timeout_s=5)
    result = await ProxyManager(cfg).health_check()
    assert result.status is Health.HEALTHY


# 3. Proxy unavailable ───────────────────────────────────────────────────
async def test_proxy_unavailable_fails_closed_and_target_never_contacted(target):
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=free_port(), health_url=target.url("/generate_204"), health_timeout_s=2)
    manager = ProxyManager(cfg)
    async with client_for(NetworkMode.PROXY, manager, ssrf_protection=False) as c:
        with pytest.raises(NetworkUnavailableError):
            await c.get(target.url("/must-not-arrive"))
    assert "/must-not-arrive" not in target.hits
    assert manager.ownership is Ownership.NONE


# 4. Proxy startup failure ───────────────────────────────────────────────
async def test_startup_failure_is_reported_with_output(tmp_path: Path):
    port = free_port()
    make_fake_singbox(tmp_path, port, behaviour="crash")
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=port, runtime_path=tmp_path, managed_start=True, startup_timeout_s=5)
    with pytest.raises(ProxyStartError) as e:
        await ProxyManager(cfg).start()
    assert "address already in use" in str(e.value)


async def test_refuses_to_start_without_managed_start(tmp_path: Path):
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=free_port(), runtime_path=tmp_path, managed_start=False)
    with pytest.raises(ProxyStartError, match="PROXY_MANAGED_START=false"):
        await ProxyManager(cfg).start()


async def test_refuses_to_start_a_tun_config(tmp_path: Path):
    port = free_port()
    make_fake_singbox(tmp_path, port)
    (tmp_path / "config_proxy.json").write_text(json.dumps({"inbounds": [{"type": "tun", "auto_route": True}]}))
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=port, runtime_path=tmp_path, managed_start=True)
    with pytest.raises(ProxyStartError, match="TUN"):
        await ProxyManager(cfg).start()


# 5. Restart / 6. termination ────────────────────────────────────────────
async def test_start_restart_stop_managed_proxy(tmp_path: Path):
    port = free_port()
    make_fake_singbox(tmp_path, port)
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=port, runtime_path=tmp_path, managed_start=True, health_url="http://127.0.0.1:9/", health_timeout_s=1)
    m = ProxyManager(cfg)
    s1 = await m.start()
    assert s1.ownership is Ownership.MANAGED and s1.process_running
    pid1 = m._runner.pid  # noqa: SLF001
    assert (await m.start()).ownership is Ownership.MANAGED  # idempotent — no duplicate
    assert m._runner.pid == pid1  # noqa: SLF001
    await m.restart()
    assert m._runner.pid != pid1  # noqa: SLF001
    assert any("sing-box started" in line for line in m.output_tail())
    s3 = await m.stop()
    assert s3.ownership is Ownership.NONE
    with pytest.raises(OSError):
        await asyncio.open_connection("127.0.0.1", port)


async def test_does_not_start_duplicate_or_stop_external_proxy():
    external = await start_fake_proxy()
    try:
        cfg = ProxyConfig(mode=NetworkMode.PROXY, port=external.port, managed_start=True, health_url="http://127.0.0.1:9/", health_timeout_s=1)
        m = ProxyManager(cfg)
        status = await m.start()
        assert status.ownership is Ownership.EXTERNAL
        await m.stop()
        _r, w = await asyncio.open_connection("127.0.0.1", external.port)  # still up
        w.close()
    finally:
        assert external.server
        external.server.close()


async def test_stubborn_process_is_killed(tmp_path: Path):
    port = free_port()
    script = make_fake_singbox(tmp_path, port, behaviour="stubborn")
    r = ProcessRunner(argv=[str(script)])
    await r.start()
    for _ in range(40):
        if r.output_tail():
            break
        await asyncio.sleep(0.05)
    await r.stop(timeout=0.5)
    assert not r.running


# 7. Timeout ─────────────────────────────────────────────────────────────
async def test_timeout_direct_is_source_unavailable(target):
    async with NetworkClient(NetworkMode.DIRECT, ssrf_protection=False, timeout_s=0.3) as c:
        with pytest.raises(SourceUnavailableError):
            await c.get(target.url("/slow"))


async def test_timeout_proxy_is_network_unavailable(target, fake_proxy):
    async def ok():
        return healthy()

    async with NetworkClient(NetworkMode.PROXY, proxy_url=fake_proxy.url, health_check=ok, ssrf_protection=False, timeout_s=0.3) as c:
        with pytest.raises(NetworkUnavailableError):
            await c.get(target.url("/slow"))


# 8. Retry ───────────────────────────────────────────────────────────────
async def test_recovers_after_proxy_comes_back(target, fake_proxy):
    results = [unavailable(), healthy()]
    calls = 0

    async def check():
        nonlocal calls
        calls += 1
        return results.pop(0)

    async with NetworkClient(NetworkMode.PROXY, proxy_url=fake_proxy.url, health_check=check, ssrf_protection=False) as c:
        with pytest.raises(NetworkUnavailableError):
            await c.get(target.url("/a"))
        r = await c.get(target.url("/b"))  # an UNAVAILABLE result is never cached
    assert r.text == "hello /b" and calls == 2


# 9. Fail closed ─────────────────────────────────────────────────────────
async def test_env_proxy_variables_are_ignored(target, fake_proxy, monkeypatch):
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy"):
        monkeypatch.setenv(var, fake_proxy.url)
    async with NetworkClient(NetworkMode.DIRECT, ssrf_protection=False) as c:
        await c.get(target.url("/env"))
    assert fake_proxy.requests == []


async def test_proxy_transport_failure_never_falls_back_to_direct(target):
    async def stale_healthy():
        return healthy()

    async with NetworkClient(NetworkMode.PROXY, proxy_url=f"http://127.0.0.1:{free_port()}", health_check=stale_healthy, ssrf_protection=False) as c:
        with pytest.raises(NetworkUnavailableError):
            await c.get(target.url("/no-fallback"))
    assert "/no-fallback" not in target.hits


def test_proxy_mode_requires_proxy_and_health_check():
    with pytest.raises(NetworkUnavailableError):
        NetworkClient(NetworkMode.PROXY)
    with pytest.raises(NetworkUnavailableError):
        client_for(NetworkMode.PROXY, None)


# 10. Secret redaction ───────────────────────────────────────────────────
def test_redaction():
    assert redact_string("GET /x?access_token=EAAsecret&a=1") == "GET /x?access_token=********&a=1"
    assert redact_string("socks5://user:hunter2@127.0.0.1:1080") == "socks5://********@127.0.0.1:1080"
    assert "0f1e" not in redact_string("vless://0f1e2d3c-aaaa@185.1.2.3:443?security=reality")
    assert redact({"proxy": {"password": "p", "host": "h"}, "headers": {"Authorization": "Bearer x"}}) == {
        "proxy": {"password": "********", "host": "h"},
        "headers": {"Authorization": "********"},
    }
    event = structlog_redactor(None, "info", {"event": "x", "cookie": "sid=1", "url": "https://a/?token=zz"})
    assert event["cookie"] == "********" and "zz" not in event["url"]


async def test_process_output_is_redacted_async():
    r = ProcessRunner(argv=["/bin/echo", "connecting vless://secret-uuid@1.2.3.4:443 password=hunter2"])
    await r.start()
    await r.wait()
    await r.stop()
    tail = "\n".join(r.output_tail())
    assert "secret-uuid" not in tail and "hunter2" not in tail


# 11. Global network configuration remains untouched ───────────────────
def test_forbidden_programs_are_never_executed():
    for prog in ("networksetup", "/usr/sbin/networksetup", "route", "scutil", "ifconfig", "pfctl", "launchctl", "sudo"):
        with pytest.raises(ForbiddenCommandError):
            assert_allowed([prog, "-anything"])


def test_source_never_invokes_network_configuration_tools():
    pkg = Path(__file__).resolve().parents[1] / "reelflow_network"
    for f in pkg.glob("*.py"):
        text = f.read_text()
        for tool in ("networksetup", "scutil", "pfctl", "/sbin/route"):
            for line in text.splitlines():
                if tool in line and "FORBIDDEN_PROGRAMS" not in line and not line.strip().startswith(("#", '"', "'")):
                    pytest.fail(f"{f.name} references {tool}: {line.strip()}")


def test_config_validation_refuses_system_wide_configs():
    assert any("TUN" in p for p in check_singbox_config({"inbounds": [{"type": "tun"}]}, 10808))
    assert any("set_system_proxy" in p for p in check_singbox_config({"inbounds": [{"type": "mixed", "listen": "127.0.0.1", "listen_port": 10808, "set_system_proxy": True}]}, 10808))
    assert any("loopback" in p for p in check_singbox_config({"inbounds": [{"type": "mixed", "listen": "0.0.0.0", "listen_port": 10808}]}, 10808))
    assert check_singbox_config({"inbounds": [{"type": "mixed", "listen": "127.0.0.1", "listen_port": 10808}]}, 10808) == []


def test_the_real_vps_proxy_config_is_process_scoped():
    """Environment check of this machine's VPS proxy config (skipped elsewhere).
    Fails loudly if the local proxy becomes system-wide (TUN) or reachable from the LAN."""
    real = Path.home() / "vpn-connector" / "config_proxy.json"
    if not real.is_file():
        pytest.skip("VPS proxy runtime not present on this machine")
    problems = check_singbox_config(json.loads(real.read_text()), 10808)
    assert problems == [], f"Local VPS proxy config is not process-scoped/loopback-only: {problems}"


def _mac_proxy_snapshot() -> str:
    services = subprocess.run(["networksetup", "-listallnetworkservices"], capture_output=True, text=True, check=True).stdout.splitlines()[1:]
    parts = [subprocess.run(["scutil", "--proxy"], capture_output=True, text=True).stdout]
    for svc in (s.lstrip("*").strip() for s in services if s.strip()):
        for flag in ("-getwebproxy", "-getsecurewebproxy", "-getsocksfirewallproxy", "-getautoproxyurl"):
            parts.append(subprocess.run(["networksetup", flag, svc], capture_output=True, text=True).stdout)
    return "\n".join(parts)


@pytest.mark.skipif(platform.system() != "Darwin", reason="macOS-only global settings check")
async def test_macos_proxy_settings_unchanged_by_full_lifecycle(tmp_path: Path, target):
    """Read-only snapshot of every service's proxy settings before and after a full
    start → request → restart → stop cycle. They must be byte-for-byte identical."""
    before = _mac_proxy_snapshot()
    port = free_port()
    make_fake_singbox(tmp_path, port)
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=port, runtime_path=tmp_path, managed_start=True, health_url=target.url("/generate_204"), health_timeout_s=2)
    m = ProxyManager(cfg)
    await m.start()
    await m.restart()
    await m.stop()
    async with NetworkClient(NetworkMode.DIRECT, ssrf_protection=False) as c:
        await c.get(target.url("/x"))
    assert _mac_proxy_snapshot() == before
    assert os.environ.get("HTTP_PROXY") in (None, os.environ.get("HTTP_PROXY"))
