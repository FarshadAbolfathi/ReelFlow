# Security model

| Area | Implementation |
|---|---|
| Passwords | argon2id (`@node-rs/argon2`), ≥ 12 chars; constant-time path for unknown emails |
| Sessions | 32-byte random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production); only its SHA-256 is stored; 7-day sliding expiry |
| CSRF | per-session token required in `x-csrf-token` for every non-GET request |
| Login abuse | 5 failures / 15 min per email+IP (Redis), plus 10 req/min on the login route |
| API rate limit | 600 req/min/IP (Redis-backed) |
| Authorization | role matrix in `packages/security/src/rbac.ts`; checked in API routes *and* in core services |
| Secrets at rest | Instagram tokens and in-app Instagram logins (password/sessionid + session cookies) encrypted with AES-256-GCM (`ENCRYPTION_KEY`, per-account AAD, same format in Node and Python); never returned by the API or sent over Redis; UI shows only the last 4 chars of a token |
| Logging | pino/structlog redaction of passwords, tokens, cookies, auth headers, proxy credentials, `vless://` ids |
| Input validation | zod schemas for every body/query; Python pydantic |
| SSRF | scheme/port/credential checks, blocked hostnames and ranges (loopback, private, link-local, CGNAT, metadata, IPv4-mapped IPv6, legacy IPv4 forms), DNS answers re-checked and pinned for the connection, every redirect re-validated. Same vectors tested in TS and Python (`tests/fixtures/ssrf-vectors.json`) |
| Uploads | streamed with a byte cap, stored under a random name, verified by magic bytes, never executed |
| Paths | `safeJoin` / `is_relative_to` guards on every storage access; sanitized filenames |
| FFmpeg | `execFile` with argument arrays (no shell); watermark text rendered to PNG by Sharp so user text never enters a filter graph; only numeric values in filter strings |
| Child processes | only `ffmpeg`, `ffprobe`, `sing-box`, `yt-dlp` with fixed argv; `networksetup`, `route`, `scutil`, `pfctl`, `launchctl`, `sudo` are refused in code |
| Network | proxy settings passed explicitly per client/process; env proxies ignored; fail-closed in proxy mode |
| Headers | helmet on the API; `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` on the web app |
| Exposure | Postgres/Redis/API bound to `127.0.0.1` |

## Reporting

This is a local-first tool. If you expose the web app beyond localhost, put it behind HTTPS and a reverse proxy, set `NODE_ENV=production`, and rotate `SESSION_SECRET` / the bootstrap password.
