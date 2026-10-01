"""Instagram through an in-app login session (instagrapi, Instagram's mobile API).

Used where the official Graph API is not an option (a Meta developer app cannot
be created from Iran). One session serves both directions:

  • reading: recent posts of source pages that allow re-posting;
  • publishing: uploading the processed Reel/photo/story to the connected page.

Secrets: the account row's `encryptedToken` holds {username, password?,
sessionid?, settings} encrypted with ENCRYPTION_KEY (same AES-GCM format and
AAD as the Node side). Nothing is written to disk in clear text and nothing
secret crosses Redis — commands carry only account ids.

Pacing: every private-API call is separated by a random pause, an upload is
preceded by a feed refresh and a short random wait, and all of it runs through
the configured network mode (proxy mode fails closed). The publishing ceilings
(posts/day, posts/hour, minimum interval) are still enforced by the Node policy
gate before anything reaches this module.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, TypeVar

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from reelflow_network import NetworkMode, NetworkUnavailableError, ProxyManager

from . import db
from .repo import now
from .secretbox import decrypt_secret, encrypt_secret

log = structlog.get_logger("instagram_session")

T = TypeVar("T")
ConnFactory = Callable[[], AbstractAsyncContextManager[AsyncConnection]]

SESSION_TOKEN_HINT = "session"
BLOB_KIND = "ig-session"


def account_aad(account_id: str) -> str:
    return f"account:{account_id}"


class SessionError(Exception):
    """A typed failure; `code` is one of the Node ErrorCode values."""

    def __init__(self, code: str, message: str, *, reason: str | None = None, retry_after_s: float | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.retry_after_s = retry_after_s

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"code": self.code, "message": str(self)}
        if self.reason:
            d["reason"] = self.reason
        if self.retry_after_s:
            d["retryAfterMs"] = int(self.retry_after_s * 1000)
        return d


@dataclass
class SessionBlob:
    username: str
    password: str | None = None
    sessionid: str | None = None
    settings: dict[str, Any] | None = None
    kind: str = BLOB_KIND

    def dumps(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def loads(cls, raw: str) -> "SessionBlob":
        try:
            d = json.loads(raw)
        except json.JSONDecodeError as e:
            raise SessionError("AUTH_EXPIRED", "This account was connected with a Graph API token, not an Instagram login") from e
        if not isinstance(d, dict) or d.get("kind") != BLOB_KIND or not d.get("username"):
            raise SessionError("AUTH_EXPIRED", "This account was connected with a Graph API token, not an Instagram login")
        return cls(username=d["username"], password=d.get("password"), sessionid=d.get("sessionid"), settings=d.get("settings"))


@dataclass(frozen=True)
class Pacing:
    """Random pauses so the session behaves like a person using the app."""

    request_delay: tuple[float, float] = (2.0, 6.0)
    pre_upload_pause: tuple[float, float] = (6.0, 20.0)
    warmup_feed: bool = True


@dataclass
class MediaSummary:
    pk: str
    code: str
    media_type: str  # VIDEO | IMAGE
    media_url: str | None
    permalink: str
    caption: str | None
    author: str | None
    taken_at: Any = None
    extra: dict[str, Any] = field(default_factory=dict)


def _media_url_and_type(m: Any) -> tuple[str | None, str]:
    """Picks the downloadable file of a post. Albums use their first item."""
    if getattr(m, "media_type", None) == 8 and getattr(m, "resources", None):
        r = m.resources[0]
        if r.media_type == 2 and r.video_url:
            return str(r.video_url), "VIDEO"
        return (str(r.thumbnail_url) if r.thumbnail_url else None), "IMAGE"
    if getattr(m, "media_type", None) == 2 and getattr(m, "video_url", None):
        return str(m.video_url), "VIDEO"
    url = getattr(m, "thumbnail_url", None)
    if url is None and getattr(m, "image_versions2", None):
        cands = getattr(m.image_versions2, "candidates", None) or []
        url = cands[0].url if cands else None
    return (str(url) if url else None), "IMAGE"


def summarize(m: Any) -> MediaSummary:
    url, mtype = _media_url_and_type(m)
    path = "reel" if getattr(m, "product_type", "") == "clips" else "p"
    user = getattr(m, "user", None)
    return MediaSummary(
        pk=str(m.pk),
        code=m.code,
        media_type=mtype,
        media_url=url,
        permalink=f"https://www.instagram.com/{path}/{m.code}/",
        caption=getattr(m, "caption_text", None) or None,
        author=getattr(user, "username", None),
        taken_at=getattr(m, "taken_at", None),
    )


def root_cause(e: BaseException) -> str:
    """The innermost error text — instagrapi wraps transport failures generically."""
    seen = set()
    while (e.__cause__ or e.__context__) is not None and id(e) not in seen:
        seen.add(id(e))
        e = e.__cause__ or e.__context__  # type: ignore[assignment]
    return f"{type(e).__name__}: {e}"


def is_curl_transport_failure(e: BaseException) -> bool:
    seen = set()
    cur: BaseException | None = e
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if "curl private transport" in str(cur):
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def map_exception(e: BaseException) -> SessionError:
    """Maps instagrapi/requests exceptions to typed errors (by class name, so the
    mapping keeps working across instagrapi versions)."""
    if isinstance(e, SessionError):
        return e
    if isinstance(e, NetworkUnavailableError):
        return SessionError("NETWORK_UNAVAILABLE", str(e))
    names = {c.__name__ for c in type(e).__mro__}
    msg = str(e) or type(e).__name__
    if "TwoFactorRequired" in names:
        return SessionError("AUTH_EXPIRED", "Two-factor authentication is on: enter the 6-digit code and connect again", reason="TWO_FACTOR_REQUIRED")
    if names & {"ChallengeRequired", "ChallengeError", "ChallengeRedirection", "ChallengeSelfieCaptcha", "RecaptchaChallengeForm", "SubmitPhoneNumberForm", "SelectContactPointRecoveryForm", "ChallengeUnknownStep"}:
        return SessionError(
            "AUTH_EXPIRED",
            "Instagram wants to confirm this login. Open Instagram on your phone, tap “This was me”, then connect again — or connect with a sessionid from a logged-in browser.",
            reason="CHALLENGE_REQUIRED",
        )
    if names & {"BadPassword", "BadCredentials"}:
        return SessionError("AUTH_EXPIRED", "Wrong username or password", reason="BAD_CREDENTIALS")
    if names & {"AccountSuspended"}:
        return SessionError("AUTH_EXPIRED", f"Instagram suspended or restricted this account: {msg}", reason="ACCOUNT_SUSPENDED")
    if names & {"LoginRequired", "ClientLoginRequired", "ReloginAttemptExceeded", "ClientUnauthorizedError"}:
        return SessionError("AUTH_EXPIRED", "The Instagram session expired — reconnect the account", reason="LOGIN_REQUIRED")
    if names & {"PleaseWaitFewMinutes", "RateLimitError", "ClientThrottledError", "FeedbackRequired", "SentryBlock"}:
        return SessionError("RATE_LIMITED", f"Instagram asked to slow down: {msg}", retry_after_s=30 * 60)
    if names & {"UserNotFound", "PrivateAccount", "MediaNotFound", "NotFoundError", "ClientNotFoundError", "InvalidTargetUser"}:
        return SessionError("SOURCE_UNAVAILABLE", f"Instagram: {msg}")
    if names & {"VideoTooLongException", "VideoNotUpload", "PhotoNotUpload", "ClipNotUpload", "IGTVNotUpload", "AlbumConfigureError"}:
        return SessionError("MEDIA_INVALID", f"Instagram rejected the media: {msg}")
    if names & {"ProxyAddressIsBlocked", "ClientConnectionError", "ClientRequestTimeout", "ClientIncompleteReadError", "ConnectionError", "Timeout", "ProxyError"}:
        cause = root_cause(e)
        return SessionError("NETWORK_UNAVAILABLE", f"Could not reach Instagram: {msg}" + (f" — {cause}" if cause.split(": ", 1)[-1] not in msg else ""))
    return SessionError("PUBLISH_FAILED", f"Instagram: {msg}")


def default_client_factory(delay_range: list[float]) -> Any:
    try:
        from instagrapi import Client
    except ImportError as e:  # pragma: no cover — dependency of the engine
        raise SessionError("PLATFORM_UNSUPPORTED", "instagrapi is not installed — run ./scripts/setup-python.sh") from e
    return Client(delay_range=delay_range)


class InstagramSessions:
    def __init__(
        self,
        begin: ConnFactory,
        key: bytes,
        *,
        network_mode: NetworkMode,
        proxy: ProxyManager | None,
        pacing: Pacing = Pacing(),
        client_factory: Callable[[list[float]], Any] = default_client_factory,
        sleep: Callable[[float], None] = time.sleep,
        transport: str = "auto",
    ) -> None:
        self.begin = begin
        self.key = key
        self.network_mode = network_mode
        self.proxy = proxy
        self.pacing = pacing
        self.client_factory = client_factory
        self.sleep = sleep
        self._locks: dict[str, asyncio.Lock] = {}
        # "curl" (looks most like the app), "requests", or "auto": curl, falling back to
        # requests once curl cannot connect (some proxies/networks break its HTTP/2 setup).
        if transport not in {"auto", "curl", "requests"}:
            raise ValueError("INSTAGRAM_TRANSPORT must be auto, curl or requests")
        self.transport = transport
        self._use_requests = transport == "requests"

    # ── persistence ─────────────────────────────────────────────────────
    async def _row(self, *, account_id: str | None = None, external_id: str | None = None) -> dict[str, Any]:
        a = db.publishing_accounts
        q = select(a).where(a.c.platform == "INSTAGRAM")
        q = q.where(a.c.id == account_id) if account_id else q.where(a.c.externalAccountId == external_id)
        async with self.begin() as conn:
            row = (await conn.execute(q)).mappings().first()
        if row is None:
            raise SessionError("NOT_FOUND", "Instagram account not found")
        if not row["encryptedToken"]:
            raise SessionError("AUTH_EXPIRED", "Account is not connected")
        return dict(row)

    def _blob(self, row: dict[str, Any]) -> SessionBlob:
        try:
            raw = decrypt_secret(row["encryptedToken"], self.key, account_aad(str(row["id"])))
        except ValueError as e:
            raise SessionError("AUTH_EXPIRED", "Stored session cannot be decrypted (ENCRYPTION_KEY changed?) — reconnect the account") from e
        return SessionBlob.loads(raw)

    async def _save(self, account_id: str, blob: SessionBlob, **values: Any) -> None:
        async with self.begin() as conn:
            await conn.execute(
                update(db.publishing_accounts)
                .where(db.publishing_accounts.c.id == account_id)
                .values(encryptedToken=encrypt_secret(blob.dumps(), self.key, account_aad(account_id)), updatedAt=now(), **values)
            )

    async def _record_error(self, account_id: str, err: SessionError) -> None:
        values: dict[str, Any] = {"lastErrorAt": now(), "lastErrorCode": err.code, "lastError": str(err)[:1000], "updatedAt": now()}
        if err.code == "AUTH_EXPIRED":
            values["status"] = "AUTH_EXPIRED"
        async with self.begin() as conn:
            await conn.execute(update(db.publishing_accounts).where(db.publishing_accounts.c.id == account_id).values(**values))

    async def reader_account_id(self, preferred: str | None = None) -> str:
        """Account used to read source pages: the source's own choice, else the
        oldest connected login-session account."""
        a = db.publishing_accounts
        q = select(a.c.id).where(a.c.platform == "INSTAGRAM", a.c.status == "CONNECTED", a.c.tokenHint == SESSION_TOKEN_HINT)
        if preferred:
            q = q.where(a.c.id == preferred)
        async with self.begin() as conn:
            row = (await conn.execute(q.order_by(a.c.updatedAt.asc()).limit(1))).first()
        if row is None:
            raise SessionError(
                "AUTH_EXPIRED",
                "No Instagram account is logged in. Connect one under Accounts (Instagram login) — it is also used to read source pages.",
                reason="NO_READER",
            )
        return str(row.id)

    # ── network ─────────────────────────────────────────────────────────
    async def _proxy_url(self) -> str | None:
        if self.network_mode is NetworkMode.DIRECT:
            return None
        if self.proxy is None:
            raise NetworkUnavailableError("PROXY mode requested but no proxy manager configured")
        health = await self.proxy.health_check()
        if health.status.value == "UNAVAILABLE":
            raise NetworkUnavailableError(f"Proxy unavailable: {health.error}")
        return self.proxy.get_proxy_url()

    # ── session lifecycle (sync, runs in a worker thread) ───────────────
    def _open(self, blob: SessionBlob, proxy_url: str | None, verification_code: str | None = None) -> Any:
        cl = self.client_factory(list(self.pacing.request_delay))
        if blob.settings:
            cl.set_settings(blob.settings)
        cl.set_proxy(proxy_url)  # None clears any proxy stored in old settings
        if hasattr(cl, "set_retry_config"):
            cl.set_retry_config(private_transport="requests" if self._use_requests else "curl")
        if blob.password:
            # Re-uses a valid stored session; performs a fresh login only when needed.
            cl.login(blob.username, blob.password, verification_code=verification_code or "")
        elif blob.sessionid and not blob.settings:
            cl.login_by_sessionid(blob.sessionid)
        elif not blob.settings:
            raise SessionError("AUTH_EXPIRED", "No password or sessionid stored — reconnect the account")
        return cl

    def _relogin(self, cl: Any, blob: SessionBlob) -> None:
        if blob.password:
            cl.login(blob.username, blob.password, relogin=True)
        elif blob.sessionid:
            cl.login_by_sessionid(blob.sessionid)
        else:
            raise SessionError("AUTH_EXPIRED", "The Instagram session expired — reconnect the account")

    async def run(self, fn: Callable[[Any], T], *, account_id: str | None = None, external_id: str | None = None, verification_code: str | None = None) -> T:
        """Runs `fn(client)` with the account's session, one call per account at a
        time, and stores the refreshed session afterwards."""
        row = await self._row(account_id=account_id, external_id=external_id)
        aid = str(row["id"])
        lock = self._locks.setdefault(aid, asyncio.Lock())
        async with lock:
            try:
                blob = self._blob(row)
                proxy_url = await self._proxy_url()

                def attempt() -> tuple[T, dict[str, Any]]:
                    cl = self._open(blob, proxy_url, verification_code)
                    try:
                        result = fn(cl)
                    except Exception as e:  # noqa: BLE001
                        if map_exception(e).reason != "LOGIN_REQUIRED":
                            raise
                        self._relogin(cl, blob)
                        result = fn(cl)
                    return result, cl.get_settings()

                def work() -> tuple[T, dict[str, Any]]:
                    try:
                        return attempt()
                    except Exception as e:
                        if self.transport != "auto" or self._use_requests or not is_curl_transport_failure(e):
                            raise
                        log.warning("instagram_transport_fallback", account=aid, error=root_cause(e)[:300])
                        self._use_requests = True
                        return attempt()

                result, settings = await asyncio.to_thread(work)
            except Exception as e:
                err = map_exception(e)
                log.warning("instagram_session_error", account=aid, code=err.code, reason=err.reason, error=str(e)[:300])
                await self._record_error(aid, err)
                if err is e:
                    raise
                raise err from e
            blob.settings = settings
            await self._save(aid, blob)
            return result

    # ── operations ──────────────────────────────────────────────────────
    async def login(self, account_id: str, verification_code: str | None = None) -> dict[str, Any]:
        def who(cl: Any) -> dict[str, Any]:
            info = cl.account_info()
            return {"userId": str(info.pk), "username": info.username}

        ident = await self.run(who, account_id=account_id, verification_code=verification_code)
        async with self.begin() as conn:
            await conn.execute(
                update(db.publishing_accounts)
                .where(db.publishing_accounts.c.id == account_id)
                .values(status="CONNECTED", username=ident["username"], tokenHint=SESSION_TOKEN_HINT, lastError=None, lastErrorCode=None, updatedAt=now())
            )
        return ident

    async def identity(self, external_id: str) -> dict[str, Any]:
        def who(cl: Any) -> dict[str, Any]:
            info = cl.account_info()
            return {"userId": str(info.pk), "username": info.username}

        return await self.run(who, external_id=external_id)

    async def publish(self, external_id: str, *, kind: str, media_type: str, file_path: Path, caption: str) -> dict[str, Any]:
        pacing = self.pacing

        def upload(cl: Any) -> dict[str, Any]:
            if pacing.warmup_feed:
                try:
                    cl.get_timeline_feed()  # the app loads the feed before you post
                except Exception:  # noqa: BLE001 — cosmetic
                    pass
            self.sleep(random.uniform(*pacing.pre_upload_pause))
            if kind == "STORY":
                story = cl.video_upload_to_story(file_path) if media_type == "VIDEO" else cl.photo_upload_to_story(file_path)
                return {"externalPostId": str(story.pk), "permalink": None}
            m = cl.clip_upload(file_path, caption) if media_type == "VIDEO" else cl.photo_upload(file_path, caption)
            return {"externalPostId": str(m.pk), "permalink": summarize(m).permalink}

        return await self.run(upload, external_id=external_id)

    async def recent_media(self, reader_id: str, username: str, amount: int) -> list[MediaSummary]:
        def fetch(cl: Any) -> list[MediaSummary]:
            uid = cl.user_id_from_username(username)
            return [summarize(m) for m in cl.user_medias(uid, amount=amount)]

        return await self.run(fetch, account_id=reader_id)

    async def media(self, reader_id: str, pk: str) -> MediaSummary:
        return await self.run(lambda cl: summarize(cl.media_info(pk, use_cache=False)), account_id=reader_id)
