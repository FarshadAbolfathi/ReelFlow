# ReelFlow

Local-first content pipeline and publishing platform, built to be policy-respecting:

```
DISCOVER → VALIDATE → INGEST → PROCESS → APPROVE → SCHEDULE → PUBLISH → ANALYZE
```

- **Persian-first (RTL) dashboard** with Jalali calendar, dark/light theme, English ready.
- **Owner-vetted sources** — a manager (the client) can only *propose* sources; nothing is imported until the owner approves them.
- **Hard publishing ceilings** set by the operator (default **10 posts/day**, 2/hour, 60 min apart, 4 per source/day). UI settings can never exceed them; manual scheduling is limit-checked too.
- **Auto-publish** switch (off by default). Content with unknown rights never auto-publishes; third-party content always carries attribution.
- **Official Instagram Graph API** publishing (resumable upload → status → `media_publish`). No passwords, no browser automation, no rate-limit workarounds — a 429 pauses the account.
- **Duplicate detection** in 4 layers (URL, source+id, SHA-256, perceptual/video fingerprint). Duplicates are linked, never stored twice.
- **FFmpeg pipeline** — one encode per output, watermark engine with live preview, Reel/Feed/Story presets.
- **Process-scoped proxy** — only ReelFlow's own traffic can use your VPS proxy; macOS network settings are never touched; proxy mode **fails closed**.
- Every stage is a recorded, idempotent job; every automated action is in the audit log.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · VPS proxy integration: [docs/VPS_PROXY_INTEGRATION.md](docs/VPS_PROXY_INTEGRATION.md) · Security: [docs/SECURITY.md](docs/SECURITY.md) · Roadmap: [TODO.md](TODO.md)

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.12 (tested 24.9) | npm workspaces |
| Python | ≥ 3.12 | ingestion engine |
| Docker | any recent | PostgreSQL 16 + Redis 7 |
| FFmpeg / ffprobe | ≥ 6 with libx264 | `brew install ffmpeg` |

## Install & run (development)

```bash
npm install                 # Node deps (also generates the Prisma client)
npm run setup               # creates .env with random secrets (never overwrites)
npm run infra:up            # PostgreSQL :5434 and Redis :6380 (loopback only)
npm run db:migrate          # apply migrations
npm run db:seed             # first OWNER account + watermark presets + caption template
./scripts/setup-python.sh   # .venv with the Python ingestion engine
npm run dev                 # API :4000, worker, web :3100, ingestion engine
```

Open **http://localhost:3100** and sign in with `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_PASSWORD` from `.env`. Change the password in *Settings → Security*.

`npm run dev -- api web` starts a subset. Ports can be changed with `API_PORT`, `WEB_PORT`, `POSTGRES_PORT`, `REDIS_PORT`.

### First steps in the UI

1. **Accounts** → connect an Instagram professional account with an access token from Meta's OAuth flow. (While `PUBLISHING_ADAPTER_MODE=mock`, nothing is actually posted.)
2. **Sources** → add a source. For pages that send you their clips, use the **inbox folder** type and drop files into `storage/inbox/<source-name>/` (a same-name `.txt` file becomes the caption).
3. **Library** → processed items wait for approval (SEMI_AUTO mode); approve, edit captions, preview original vs. processed.
4. **Calendar** → create a weekly schedule (days, times/windows, source weights) and schedule posts; drag to reschedule.
5. **Settings → Publishing** → turn on auto-publish when you're ready.

## Production

```bash
npm run build               # API/worker bundles + Next.js production build
npm run db:deploy           # migrations without dev prompts
NODE_ENV=production npm start
```

`npm start` runs the API, worker, web (`next start`) and ingestion engine. For always-on use, run each with a supervisor (launchd/systemd/pm2) using the same commands as in `scripts/dev.mjs --prod`. Keep the API on `127.0.0.1`; expose only the web app, behind HTTPS if it leaves the machine (session cookies become `Secure` in production).

## CLI

```bash
npm run reelflow -- health
npm run reelflow -- source add -n "Funny Page" -p LOCAL -r PERMISSION_GRANTED -a "🎬 via @funnypage"
npm run reelflow -- source list
npm run reelflow -- source approve <id>
npm run reelflow -- content import ./clip.mp4 -r PERMISSION_GRANTED -s <sourceId>
npm run reelflow -- content process <contentId> --preset INSTAGRAM_REEL
npm run reelflow -- queue status
npm run reelflow -- schedule post <contentId> <accountId> --at 2026-10-03T18:30:00+03:30
npm run reelflow -- schedule fill <scheduleId> --days 3
npm run reelflow -- worker start --with-ingestion
```

IDs accept a unique 8-character prefix as printed by `list`. CLI actions run as the owner and are audit-logged with actor `CLI`.

## Network: direct or VPS proxy

```ini
NETWORK_MODE=proxy          # or direct
PROXY_HOST=127.0.0.1
PROXY_PORT=10808            # sing-box "mixed" inbound (HTTP + SOCKS5)
PROXY_MANAGED_START=false   # true lets ReelFlow start sing-box itself if nothing is listening
```

Only ReelFlow's HTTP clients, `yt-dlp` child processes and an optional isolated browser profile use the proxy. If the proxy is down in proxy mode, jobs fail with `NETWORK_UNAVAILABLE` and retry — they never silently go direct. Status and Test/Start/Stop/Restart are under *Settings → Network* (owner only). Details: [docs/VPS_PROXY_INTEGRATION.md](docs/VPS_PROXY_INTEGRATION.md).

## Policy ceilings (operator-only)

```ini
POLICY_MAX_POSTS_PER_DAY=10
POLICY_MAX_POSTS_PER_HOUR=2
POLICY_MIN_POST_INTERVAL_MINUTES=60
POLICY_MAX_CONCURRENT_PUBLISH=1
POLICY_MAX_POSTS_PER_SOURCE_PER_DAY=4
POLICY_SOURCES_REQUIRE_OWNER_APPROVAL=true
```

These live in `.env` on the machine you control and are clamped in code to absolute maxima (25/day, 3/hour, ≥ 20 min). A `MANAGER` cannot change them from the UI; a request for more is rejected with `POLICY_LIMIT_EXCEEDED`.

## Tests

```bash
npm run test                # 185 unit tests (security, SSRF, policy, scheduler/timezones, media+FFmpeg, adapters, captions)
npm run test:integration    # 26 tests on real Postgres/Redis (vetting, limits, publish flow, 429 pause, idempotency, auth)
npm run test:python         # network isolation (62) + ingestion engine (16)
npm run test:e2e            # Playwright UI flows — needs `npm run dev` running
npm run lint && npm run typecheck
```

Integration tests use a separate `reelflow_test` database and Redis DB 1/2; your development data is never touched.

## Troubleshooting

- **`Cannot find module '../lightningcss.darwin-arm64.node'`** during `next build`: an npm optional-dependency bug. Run `npm i --no-save lightningcss-darwin-arm64@$(node -p "require('lightningcss/package.json').version")` and delete `apps/web/.next`.
- **Port already in use**: another project uses 3000/5432/5433 on this machine; ReelFlow defaults to 3100/5434/6380. Override with the env vars above.
- **Ingestion engine not responding** in *Settings → Network*: start it with `npm run dev:ingestion`.

## Repository layout

```
apps/api            Fastify API (auth, RBAC, CSRF, validation, routes)
apps/worker         BullMQ workers + scheduler tick + ingestion-event bridge
apps/web            Next.js dashboard (RTL, Persian)
apps/cli            reelflow CLI
apps/ingestion      Python ingestion engine (adapters, download, dedupe, streams)
packages/types      enums, error codes, queue contracts, zod schemas
packages/config     env config, policy ceilings, settings
packages/database   Prisma schema, migrations, seed
packages/core       domain services (sources, content, scheduling, publishing, …)
packages/scheduler  slots, allocation, policy gate, safety monitor, backoff
packages/media      FFmpeg/Sharp pipeline, watermark engine, presets
packages/platform-adapters  PublishingAdapter, Instagram Graph API, mock
packages/http       Node network client (direct/proxy, fail-closed, SSRF)
packages/network    Python network package (ProxyManager, NetworkClient, SSRF)
packages/security   argon2, AES-GCM, SSRF, safe paths, RBAC
packages/logger     pino with secret redaction
packages/ui         shared UI primitives
storage/            originals, processed, thumbnails, previews, inbox, failed (gitignored)
```
