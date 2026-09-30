# VPS Proxy integration — inspection findings and design

Inspected on 2026-09-26. Nothing in either project was modified.

## What exists on this machine

### `/Users/farshad/Desktop/projects/programming/vpn-app` (Flutter "VPN Client")

* `lib/vpn_service.dart` → `DesktopVpnBackend` runs `sing-box` with a config generated
  from a `vless://` link (`lib/vless_to_singbox.dart`), SOCKS/HTTP `mixed` inbound on
  `127.0.0.1:2080`, **and then calls `networksetup -setsocksfirewallproxy` on every
  network service**, i.e. it changes the macOS system proxy.
* No desktop build and no `sing-box` binary are present in the project.

**Conclusion:** ReelFlow must **not** launch this app — doing so would violate the
"never alter global macOS networking" rule. The path is validated at startup
(`pubspec.yaml`, `lib/vless_to_singbox.dart`) for reference only.

### `~/vpn-connector` (the runtime that actually provides the proxy)

| Item              | Value                                                                  |
|-------------------|------------------------------------------------------------------------|
| Binary            | `~/vpn-connector/bin/sing-box` (1.13.13, darwin/arm64)                 |
| Config            | `~/vpn-connector/config_proxy.json`                                    |
| Protocol          | sing-box `mixed` inbound → **HTTP (CONNECT) and SOCKS5** on one port   |
| Host / port       | `127.0.0.1:10808`                                                      |
| Authentication    | none (loopback only)                                                   |
| Upstream          | `urltest` between VLESS+WS (Cloudflare worker) and VLESS+Reality (VPS) |
| Started by        | launchd agent `com.farshad.vpnproxy` (`RunAtLoad`, `KeepAlive`)        |
| Manual start      | `proxy.command` → `./bin/sing-box run -c config_proxy.json`            |
| Health check      | `GET https://www.gstatic.com/generate_204` through the proxy → 204     |
| Shutdown          | launchd-managed: leave it; child we started: SIGTERM, then SIGKILL      |
| Measured latency  | ≈2.5 s for a 204 round trip → health-check timeout ≥ 15 s              |

`control.py` / `config_tun.json` in the same folder use a **TUN device (system-wide
routing, needs sudo)**. ReelFlow never uses them.

## ReelFlow design

```
NETWORK_MODE=direct | proxy
PROXY_PROVIDER=vps-proxy
PROXY_SCHEME=http | socks5          # mixed inbound supports both; http is used by default
PROXY_HOST=127.0.0.1
PROXY_PORT=10808
VPS_PROXY_PROJECT_PATH=/Users/farshad/Desktop/projects/programming/vpn-app
VPS_PROXY_RUNTIME_PATH=/Users/farshad/vpn-connector
VPS_PROXY_BINARY=bin/sing-box                 # relative to runtime path
VPS_PROXY_CONFIG=config_proxy.json            # relative to runtime path
PROXY_MANAGED_START=false            # true → ReelFlow may spawn sing-box itself
```

`ProxyManager` (`packages/network/reelflow_network/proxy_manager.py`):

1. **Detect**: is something listening on `PROXY_HOST:PROXY_PORT`? Is it sing-box
   (`pgrep -f "sing-box run -c <config>"`)? If yes → `ownership = EXTERNAL`; ReelFlow
   uses it and **never stops it**.
2. **Start** (only if `PROXY_MANAGED_START=true` and nothing is listening): validate the
   config first — it must contain **no `tun` inbound**, and every inbound must listen on
   a loopback address — then spawn `sing-box run -c <config>` with stdout/stderr
   captured, wait for the port, run the health check. `ownership = MANAGED`.
3. **Stop / restart**: only for `MANAGED` children (SIGTERM → wait → SIGKILL).
4. **Health**: TCP connect → HTTP 204 probe through the proxy → report
   `HEALTHY | DEGRADED | UNAVAILABLE` with last error and timestamp.

Every network job declares `NetworkMode.DIRECT` or `NetworkMode.PROXY`. Before running:
`assert_mode_available(mode)`; if PROXY is requested and health is not `HEALTHY`, the
job fails with `NETWORK_UNAVAILABLE` and is retried by policy. **There is no fallback
to direct.** Proxy settings are passed explicitly to `httpx.AsyncClient(proxy=…)`,
to `yt-dlp --proxy …`, and to Playwright `launch_persistent_context(proxy=…)` with
`user_data_dir=storage/browser-profile`. Environment proxy variables are ignored
(`trust_env=False`) so nothing is inherited implicitly.

The Node publisher uses the same rules via `packages/http` (undici `ProxyAgent`).
