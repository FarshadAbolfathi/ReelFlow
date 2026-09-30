# ReelFlow — build log & roadmap

Legend: ✅ done and tested · 🟡 done, needs real-world verification · ⏭ future

## Phase 1 — Foundation
- ✅ Monorepo (npm workspaces), strict TypeScript, ESLint, Vitest, Playwright
- ✅ Docker Compose: PostgreSQL 16 (:5434) + Redis 7 (:6380), loopback-only
- ✅ Prisma schema (all core entities, UUIDs, indexes), migrations, idempotent seed
- ✅ Fastify API: sessions, CSRF, RBAC, rate limits, typed errors, audit
- ✅ Next.js dashboard shell (RTL, Persian, dark/light)

## Phase 2 — Content
- ✅ Sources with owner vetting, rights status, attribution
- ✅ Python ingestion engine: adapters (feed, inbox folder, direct URL, yt-dlp allow-list, Instagram boundary)
- ✅ Local upload with magic-byte validation
- ✅ 4-layer duplicate detection (URL, source+id, SHA-256, dHash/video fingerprint)
- ✅ FFmpeg pipeline (single encode, stream-copy when possible), presets, thumbnails, previews
- ✅ Watermark engine + editor with live server-rendered preview

## Phase 3 — Scheduling
- ✅ Weekly schedules (times, windows, min interval, source weights), Asia/Tehran default, DST-safe
- ✅ Calendar month/week/day/agenda with drag-and-drop, Jalali calendar for Persian UI
- ✅ Queue with pause/resume/cancel/retry/reschedule/approve
- ✅ Approval modes AUTO / SEMI_AUTO / MANUAL

## Phase 4 — Publishing
- ✅ PublishingAdapter interface + registry, mock adapter
- 🟡 Instagram Graph API adapter (resumable Reels/Stories upload, status poll, publish, quota, insights) — tested against a simulated API; needs a real Meta app + token to verify end-to-end
- ✅ Policy gate before every publish; ceilings; per-account daily limit
- ✅ Safety monitor (429 → pause with backoff/Retry-After; auth expiry → pause until reconnect)
- ✅ Retries with exponential backoff; idempotent container re-use

## Phase 5 — Operations
- ✅ Analytics (imports, publishes, failures, success rate, source contribution); platform metrics only if the API returns them
- ✅ Notification centre (+ `NotificationChannel` interface)
- ✅ CLI
- ✅ Settings incl. Network (proxy status/controls), Security (users)
- ✅ Retention cleanup that never deletes media of active posts

## Phase 6 — Hardening
- ✅ SSRF, path traversal, safe FFmpeg args, upload limits, secret redaction, encrypted tokens
- ✅ Network isolation tests incl. "macOS proxy settings unchanged" snapshot
- ✅ E2E pipeline run on the live stack; Playwright UI tests

## Open items
- ⏭ **Image posts to Instagram** need a publicly reachable `image_url`. Local mode returns `PLATFORM_UNSUPPORTED`. Option: a signed, short-lived public media endpoint (tunnel or S3-compatible storage).
- ⏭ **Meta OAuth flow in-app** (currently the token is pasted). Add "Connect with Facebook/Instagram" + automatic long-lived token refresh.
- 🟡 **Instagram login mode** (`PUBLISHING_ADAPTER_MODE=session`): in-app login (password + 2FA or browser sessionid), automatic reading of Instagram source pages and publishing through the session — tested against a fake client; needs a real account to verify end-to-end. Interactive challenge codes (email/SMS) are not handled in the UI yet: the user approves the login in the Instagram app and connects again.
- ⏭ S3-compatible `StorageService` implementation.
- ⏭ Email / Telegram / webhook `NotificationChannel`s.
- ⏭ TikTok / YouTube / Facebook publishing adapters (implement `PublishingAdapter`).
- ⏭ Multi-workspace / multi-brand tenancy (add `workspaceId` to top-level tables).
- ⏭ AI caption suggestions and content classification (behind an adapter; human approval stays).
- ⏭ Bull Board or similar queue UI for deep debugging.

## Deliberately not built
No proxy rotation, no browser fingerprint spoofing, no rate-limit or CAPTCHA workarounds (a rate limit pauses the account), no transformations meant to evade copyright detection. Instagram pages are read only through the operator's own logged-in session and only for owner-approved sources; the yt-dlp path still refuses Instagram/Facebook/TikTok.
