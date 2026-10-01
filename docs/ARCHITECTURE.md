# ReelFlow — Architecture

ReelFlow is a local-first content pipeline:

```
DISCOVER → VALIDATE → INGEST → PROCESS → APPROVE → SCHEDULE → PUBLISH → ANALYZE
```

Every stage is a separate, idempotent, observable job. Every external integration
sits behind an adapter. Every automated action writes an audit-log entry.

## 1. Runtime components

```
┌──────────────┐   same-origin /api/*   ┌──────────────┐
│  apps/web    │ ─────────────────────▶ │  apps/api    │  Fastify, sessions, RBAC,
│  Next.js     │   (Next rewrite)        │  (Node/TS)   │  validation, audit log
└──────────────┘                         └──────┬───────┘
                                                │ Prisma            BullMQ (Redis)
                                                ▼                        │
                                         ┌────────────┐                  │
                                         │ PostgreSQL │◀─────────────┐   │
                                         └────────────┘              │   │
                                                ▲                    │   ▼
┌───────────────────────────────┐               │           ┌──────────────────┐
│ apps/ingestion (Python 3.12)  │  SQLAlchemy   │           │ apps/worker (TS) │
│  content-discovery stream     │───────────────┘           │ media-processing │
│  media-download stream        │                           │ watermark        │
│  network control channel      │── ingestion events ──────▶│ thumbnail        │
│  packages/network (proxy mgr) │                           │ approval         │
└──────────────┬────────────────┘                           │ publishing       │
               │ only this process (and the publisher)      │ analytics        │
               ▼ receives proxy settings                    │ cleanup          │
      127.0.0.1:10808 (sing-box mixed inbound)              │ scheduler tick   │
               │                                            └──────────────────┘
               ▼
           VPS (VLESS)
```

* **Prisma owns the schema and migrations.** The Python engine maps only the
  tables it needs with SQLAlchemy (`apps/ingestion/reelflow_ingestion/db.py`) and a
  contract test checks those columns exist.
* **Node ↔ Node work uses BullMQ** (processing, approval, publishing, analytics, cleanup,
  scheduler tick).
* **Node ↔ Python work crosses a Redis Streams boundary** (consumer groups), not BullMQ:
  the Node and Python BullMQ clients are versioned separately and their Lua scripts
  are not guaranteed to match, so neither side depends on the other's wire format.
  - Node → Python: `reelflow:stream:content-discovery`, `reelflow:stream:media-download`
    (added once per job id via a `SET NX` dedupe key).
  - Python → Node: `reelflow:events:ingestion` (`content_ingested`), bridged by the
    worker into the BullMQ `media-processing` queue. A 5-minute sweep re-queues any
    ingested content that was never processed.
  - Retries: Python re-schedules retryable failures with exponential backoff in a
    sorted set; stale pending messages are reclaimed with `XAUTOCLAIM`.

## 2. Roles and the source-vetting rule

| Role      | Who                          | Can                                                                 |
|-----------|------------------------------|---------------------------------------------------------------------|
| `OWNER`   | The operator (you)           | Everything; **approve/reject sources**; change policy ceilings      |
| `MANAGER` | The client / employer        | Content, captions, schedule, accounts, settings **within ceilings**; can *propose* sources |
| `VIEWER`  | Read-only                    | Read dashboards and logs                                            |

A source added by a `MANAGER` is created with `vettingStatus = PENDING_REVIEW` and
**nothing is imported from it** until an `OWNER` approves it. Imports are refused at
the ingestion layer as well as in the API (defence in depth).

## 3. Publishing policy (hard ceilings)

Two layers of limits:

1. **Policy ceilings** — from environment (`POLICY_*`), changeable only by the
   operator. Clamped in code to absolute maxima (`ABSOLUTE_LIMITS` in
   `packages/config`). Default: **10 posts/day/account**, 2/hour, 60 min min interval,
   1 concurrent publish.
2. **User settings** — editable in the UI, validated to be `≤` the ceilings. A request
   to set 20/day when the ceiling is 10 is rejected with `POLICY_LIMIT_EXCEEDED`.

The publishing gate (`packages/scheduler/src/policy-gate.ts`) runs immediately before
every publish and re-checks: ceilings, counts in the rolling windows, account safety
state, source vetting, rights status, approval state, and platform media rules.

**Auto-publish** is a setting (`publishing.autoPublishEnabled`, default `false`).
Even when on, content from sources whose rights are `UNKNOWN` never auto-publishes
when `safety.blockUnknownRights` is on (the default), and every automatic action is
written to the audit log.

## 4. Approval modes

* `AUTO` — approved automatically if source is vetted and rights permit.
* `SEMI_AUTO` (default) — imported content waits in the approval queue.
* `MANUAL` — nothing is scheduled or published without explicit approval.

## 5. Status model

`Content.processingStatus`: `PENDING → PROCESSING → READY | FAILED`
`Content.approvalStatus`: `PENDING | APPROVED | REJECTED`
`Content.duplicateOfId`: set when a layer of duplicate detection matched.
`ScheduledPost.status`: `WAITING_APPROVAL | READY | SCHEDULED | PROCESSING | PUBLISHING | PUBLISHED | FAILED | CANCELLED | PAUSED`

## 6. Idempotency

| Job                 | Idempotency key                                           |
|---------------------|-----------------------------------------------------------|
| discovery           | `(sourceId, externalId)` unique index                     |
| download / ingest   | `ingestionRequest.id`; content unique on `checksum`       |
| processing          | `(contentId, presetKey, settingsHash)` → re-used asset    |
| publishing          | BullMQ `jobId = post:<scheduledPostId>`; stored container id re-used; `externalPostId` present ⇒ no-op |

## 7. Duplicate detection layers

1. Normalized URL (`normalizeUrl`: lowercase host, strip tracking params, fragments, default ports, trailing slash)
2. `(sourceId, externalId)` — platform media id
3. SHA-256 of the file
4. Perceptual hash (images: dHash 64-bit; video: dHash of frames sampled at fixed fractions of duration, compared by average Hamming distance)

A match creates **no new file**: the ingest is recorded as `DUPLICATE` with a link
to the original content item.

## 8. Network isolation

See [VPS_PROXY_INTEGRATION.md](VPS_PROXY_INTEGRATION.md). In short: proxy settings
are injected **only** into ReelFlow's HTTP clients, child processes (`yt-dlp`) and a
dedicated browser context. ReelFlow never runs `networksetup`, never touches routes,
DNS or TUN devices, and fails closed when proxy mode is requested but unavailable.

## 9. Instagram

Two publishing modes, chosen with `PUBLISHING_ADAPTER_MODE`:

* **`live`** — official Instagram Graph API content-publishing flow
  (container → resumable upload → status poll → `media_publish`) with a
  user-granted access token.
* **`session`** — for installs that cannot create a Meta developer app (e.g. from
  Iran): the operator logs in to Instagram inside ReelFlow (password + optional
  2FA code, or a browser `sessionid`). The Python engine holds the session
  (`instagram_session.py`, instagrapi) and the Node `InstagramSessionAdapter`
  sends it commands over a Redis stream (`session_control.py` ↔
  `packages/core/src/services/instagram-session.ts`). Commands carry ids, file
  paths and captions only; the login and session cookies stay AES-GCM encrypted
  in `publishing_accounts.encryptedToken` (same format/AAD on both sides).
  Uploads are idempotent per container id (the result is kept 30 days in Redis),
  so a retried job never posts twice.

**Instagram pages as sources** (`session` mode): an `INSTAGRAM` source is a
profile URL. Discovery lists the page's latest posts through the logged-in
reader account (the source's `adapterOptions.readerAccountId`, else the oldest
connected login account); download refreshes the CDN link and fetches it with
the normal `NetworkClient` (proxy mode fails closed). `(source, post id)`
de-duplicates before any download. Sources still need owner approval and a
rights status that allows publishing — add only pages that allow re-posting.

Pacing: random 2–6 s pauses between Instagram calls, a feed refresh and a short
random wait before each upload, one call at a time per account. The publishing
ceilings (posts/day, posts/hour, minimum interval), approvals and the safety
monitor (rate limit → pause) apply exactly as in `live` mode. An expired login
or a verification challenge marks the account `AUTH_EXPIRED` until it is
reconnected on the Accounts page.
