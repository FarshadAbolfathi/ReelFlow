"""Instagram login sessions: login, reading source pages, publishing — against a
fake instagrapi client (no traffic to Instagram)."""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from instagrapi.exceptions import BadPassword, ChallengeRequired, LoginRequired, TwoFactorRequired
from sqlalchemy import select, text

from reelflow_ingestion import db
from reelflow_ingestion.adapters import AdapterRegistry
from reelflow_ingestion.adapters.instagram import username_from_url
from reelflow_ingestion.adapters.base import SourceInvalid
from reelflow_ingestion.instagram_session import InstagramSessions, Pacing, SessionBlob, SessionError, account_aad, map_exception
from reelflow_ingestion.pipeline import run_discovery, run_ingest
from reelflow_ingestion.queues import STREAMS
from reelflow_ingestion.secretbox import decrypt_secret, encrypt_secret
from reelflow_ingestion.session_control import SessionControl
from reelflow_network import NetworkClient, NetworkMode

from .conftest import REPO, insert_source, make_video

KEY = os.urandom(32)
NO_PAUSE = Pacing(request_delay=(0, 0), pre_upload_pause=(0, 0))


class World:
    def __init__(self) -> None:
        self.password = "correct horse"
        self.require_2fa = False
        self.challenge = False
        self.session_valid = True
        self.expire_mid_call = False
        self.logins: list[dict[str, Any]] = []
        self.uploads: list[tuple[str, Path, str]] = []
        self.delay_ranges: list[list[float]] = []
        self.proxies: list[str | None] = []
        self.feed_loads = 0
        self.medias: dict[str, SimpleNamespace] = {}


def media(pk: str, *, video: bool = True, minutes_ago: int = 0, caption: str = "funny #cat") -> SimpleNamespace:
    return SimpleNamespace(
        pk=pk, code=f"C{pk}", media_type=2 if video else 1, product_type="clips" if video else "feed",
        video_url=f"https://scontent.cdninstagram.com/v/{pk}.mp4" if video else None,
        thumbnail_url=f"https://scontent.cdninstagram.com/t/{pk}.jpg", resources=[], image_versions2=None,
        caption_text=caption, user=SimpleNamespace(username="sourcepage"),
        taken_at=datetime.now(UTC) - timedelta(minutes=minutes_ago),
    )


class FakeIG:
    def __init__(self, world: World, delay_range: list[float]) -> None:
        self.w = world
        self.settings: dict[str, Any] = {}
        self.logged_in = False
        world.delay_ranges.append(delay_range)

    def set_settings(self, s: dict[str, Any]) -> None:
        self.settings = dict(s)

    def set_proxy(self, dsn: str | None) -> None:
        self.w.proxies.append(dsn)

    def login(self, username: str, password: str, relogin: bool = False, verification_code: str = "") -> bool:
        if self.settings.get("cookies") and not relogin and self.w.session_valid:
            self.logged_in = True
            return True
        if password != self.w.password:
            raise BadPassword("bad password")
        if self.w.challenge:
            raise ChallengeRequired()
        if self.w.require_2fa and not verification_code:
            raise TwoFactorRequired()
        self.w.logins.append({"username": username, "relogin": relogin, "code": verification_code})
        self.w.session_valid = True
        self.settings = {"cookies": {"sessionid": "S" * 40}, "uuids": {"phone_id": "p"}}
        self.logged_in = True
        return True

    def login_by_sessionid(self, sessionid: str) -> bool:
        self.settings = {"cookies": {"sessionid": sessionid}}
        self.logged_in = True
        return True

    def get_settings(self) -> dict[str, Any]:
        return dict(self.settings)

    def _check(self) -> None:
        if self.w.expire_mid_call:
            self.w.expire_mid_call = False
            self.w.session_valid = False
        if not self.w.session_valid:
            raise LoginRequired("login_required")

    def account_info(self) -> SimpleNamespace:
        self._check()
        return SimpleNamespace(pk=4242, username="mypage")

    def get_timeline_feed(self) -> dict[str, Any]:
        self.w.feed_loads += 1
        return {}

    def user_id_from_username(self, username: str) -> str:
        self._check()
        assert username == "sourcepage"
        return "777"

    def user_medias(self, user_id: str, amount: int = 0) -> list[SimpleNamespace]:
        return list(self.w.medias.values())[:amount]

    def media_info(self, pk: str, use_cache: bool = True) -> SimpleNamespace:
        return self.w.medias[pk]

    def clip_upload(self, path: Path, caption: str) -> SimpleNamespace:
        self._check()
        self.w.uploads.append(("clip", path, caption))
        return media(f"9{len(self.w.uploads)}")

    def photo_upload(self, path: Path, caption: str) -> SimpleNamespace:
        self.w.uploads.append(("photo", path, caption))
        return media(f"8{len(self.w.uploads)}", video=False)


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def sessions(deps, world) -> InstagramSessions:
    s = InstagramSessions(deps.begin, KEY, network_mode=NetworkMode.DIRECT, proxy=None, pacing=NO_PAUSE, client_factory=lambda d: FakeIG(world, d), sleep=lambda _s: None)
    deps.registry = AdapterRegistry(deps.storage / "inbox", frozenset(), s)
    return s


async def insert_account(deps, blob: SessionBlob, *, status: str = "DISCONNECTED", external_id: str = "mypage") -> str:
    aid = str(uuid.uuid4())
    async with deps.begin() as conn:
        await conn.execute(
            text(
                'INSERT INTO publishing_accounts (id, name, platform, "externalAccountId", status, "encryptedToken", "tokenHint", "safetyState", "consecutiveFailures", "rateLimitStrikes", "createdAt", "updatedAt") '
                "VALUES (:id, 'My page', 'INSTAGRAM', :ext, CAST(:status AS \"AccountStatus\"), :tok, 'session', 'HEALTHY', 0, 0, now(), now())"
            ),
            {"id": aid, "ext": external_id, "status": status, "tok": encrypt_secret(blob.dumps(), KEY, account_aad(aid))},
        )
    return aid


async def account(deps, aid: str) -> dict[str, Any]:
    async with deps.begin() as conn:
        return dict((await conn.execute(select(db.publishing_accounts).where(db.publishing_accounts.c.id == aid))).mappings().one())


# ── crypto ────────────────────────────────────────────────────────────────
def test_secretbox_round_trip_and_aad_binding():
    token = encrypt_secret("hello", KEY, "account:a")
    assert decrypt_secret(token, KEY, "account:a") == "hello"
    with pytest.raises(ValueError):
        decrypt_secret(token, KEY, "account:b")


def test_secretbox_reads_what_node_wrote():
    tsx = REPO / "node_modules" / ".bin" / "tsx"
    if not tsx.exists() or not shutil.which("node"):
        pytest.skip("Node dependencies not installed")
    key_b64 = base64.b64encode(KEY).decode()
    script = (
        "import { encryptSecret, decryptSecret } from './packages/security/src/crypto.ts';"
        f"const k = Buffer.from('{key_b64}', 'base64');"
        "const py = process.argv.at(-1);"
        "console.log(JSON.stringify({ fromNode: encryptSecret('سلام session', k, 'account:x'), readPy: decryptSecret(py, k, 'account:x') }));"
    )
    py_token = encrypt_secret("from python", KEY, "account:x")
    out = subprocess.run([str(tsx), "-e", script, py_token], cwd=REPO, capture_output=True, text=True, check=True).stdout
    res = json.loads(out.strip().splitlines()[-1])
    assert decrypt_secret(res["fromNode"], KEY, "account:x") == "سلام session"
    assert res["readPy"] == "from python"


# ── errors / parsing ─────────────────────────────────────────────────────
def test_exception_mapping():
    assert map_exception(TwoFactorRequired()).reason == "TWO_FACTOR_REQUIRED"
    assert map_exception(ChallengeRequired()).reason == "CHALLENGE_REQUIRED"
    assert map_exception(BadPassword("x")).code == "AUTH_EXPIRED"
    from instagrapi.exceptions import FeedbackRequired, PleaseWaitFewMinutes

    for e in (PleaseWaitFewMinutes("wait"), FeedbackRequired("spam")):
        err = map_exception(e)
        assert err.code == "RATE_LIMITED" and err.retry_after_s
    assert map_exception(RuntimeError("boom")).code == "PUBLISH_FAILED"


def test_username_from_profile_url():
    assert username_from_url("https://www.instagram.com/Some.Page_1/") == "some.page_1"
    assert username_from_url("https://instagram.com/somepage?igsh=abc") == "somepage"
    for bad in ("https://www.instagram.com/reel/ABC/", "https://example.com/somepage", "https://www.instagram.com/"):
        with pytest.raises(SourceInvalid):
            username_from_url(bad)


# ── login ────────────────────────────────────────────────────────────────
async def test_login_stores_encrypted_session_and_connects(deps, sessions, world):
    aid = await insert_account(deps, SessionBlob(username="mypage", password="correct horse"))
    ident = await sessions.login(aid)
    assert ident == {"userId": "4242", "username": "mypage"}
    row = await account(deps, aid)
    assert row["status"] == "CONNECTED" and row["username"] == "mypage"
    assert "correct horse" not in row["encryptedToken"]
    blob = SessionBlob.loads(decrypt_secret(row["encryptedToken"], KEY, account_aad(aid)))
    assert blob.settings and blob.settings["cookies"]["sessionid"]
    assert world.delay_ranges[-1] == [0, 0]
    # The stored session is re-used: no second password login.
    await sessions.identity("mypage")
    assert len(world.logins) == 1


async def test_two_factor_then_code(deps, sessions, world):
    world.require_2fa = True
    aid = await insert_account(deps, SessionBlob(username="mypage", password="correct horse"))
    with pytest.raises(SessionError) as ei:
        await sessions.login(aid)
    assert ei.value.reason == "TWO_FACTOR_REQUIRED"
    assert (await account(deps, aid))["status"] == "AUTH_EXPIRED"
    await sessions.login(aid, "123456")
    assert world.logins[-1]["code"] == "123456"
    assert (await account(deps, aid))["status"] == "CONNECTED"


async def test_challenge_and_bad_password_are_reported(deps, sessions, world):
    aid = await insert_account(deps, SessionBlob(username="mypage", password="wrong"))
    with pytest.raises(SessionError) as ei:
        await sessions.login(aid)
    assert ei.value.reason == "BAD_CREDENTIALS"
    world.challenge = True
    aid2 = await insert_account(deps, SessionBlob(username="other", password="correct horse"), external_id="other")
    with pytest.raises(SessionError) as ei:
        await sessions.login(aid2)
    assert ei.value.reason == "CHALLENGE_REQUIRED" and "This was me" in str(ei.value)


async def test_sessionid_login(deps, sessions):
    aid = await insert_account(deps, SessionBlob(username="mypage", sessionid="4242%3A" + "x" * 40))
    assert (await sessions.login(aid))["username"] == "mypage"


async def test_expired_session_logs_in_again(deps, sessions, world):
    aid = await insert_account(deps, SessionBlob(username="mypage", password="correct horse"))
    await sessions.login(aid)
    world.session_valid = False  # expired between runs → fresh login when opening
    await sessions.identity("mypage")
    assert len(world.logins) == 2 and world.logins[-1]["relogin"] is False
    world.expire_mid_call = True  # expired during a call → one relogin, then the call is repeated
    assert (await sessions.identity("mypage"))["username"] == "mypage"
    assert world.logins[-1]["relogin"] is True


# ── reading a source page ────────────────────────────────────────────────
async def test_discovery_and_download_of_a_source_page(deps, sessions, world, tmp_path, monkeypatch):
    aid = await insert_account(deps, SessionBlob(username="mypage", password="correct horse"))
    await sessions.login(aid)
    world.medias = {"101": media("101", minutes_ago=10), "102": media("102", minutes_ago=5, caption="second")}
    sid = await insert_source(deps, platform="INSTAGRAM", url="https://www.instagram.com/sourcepage/")

    r = await run_discovery(deps, {"sourceId": sid}, "d1", 1)
    assert r == {"found": 2, "new": 2}
    msgs = await deps.redis.xrange(STREAMS["media-download"])
    rids = [json.loads(m[1][b"data"])["ingestionRequestId"] for m in msgs]

    clip = make_video(tmp_path / "clip.mp4")
    fetched: list[str] = []

    async def fake_download(self, url, dest, *, max_bytes):
        fetched.append(url)
        shutil.copyfile(clip if "101" in url else make_video(tmp_path / "b.mp4", color_src="mandelbrot"), dest)

    monkeypatch.setattr(NetworkClient, "download", fake_download)
    res = await run_ingest(deps, {"ingestionRequestId": rids[0]}, "j1", 1)
    async with deps.begin() as conn:
        c = (await conn.execute(select(db.contents).where(db.contents.c.id == res["contentId"]))).mappings().one()
    assert fetched == ["https://scontent.cdninstagram.com/v/101.mp4"]
    assert c["originalUrl"] == "https://www.instagram.com/reel/C101/" and c["externalId"] == "ig:101"
    assert c["author"] == "sourcepage" and c["hashtags"] == ["cat"] and c["rightsStatus"] == "PERMISSION_GRANTED"
    assert c["attribution"] == "🎬 via Funny Page"
    # Rediscovery only picks up posts it has not seen.
    world.medias["103"] = media("103", minutes_ago=1)
    assert (await run_discovery(deps, {"sourceId": sid}, "d2", 1)) == {"found": 3, "new": 1}


async def test_unapproved_instagram_source_is_not_read(deps, sessions, world):
    aid = await insert_account(deps, SessionBlob(username="mypage", password="correct horse"))
    await sessions.login(aid)
    world.medias = {"101": media("101")}
    sid = await insert_source(deps, platform="INSTAGRAM", url="https://www.instagram.com/sourcepage/", vetting="PENDING_REVIEW")
    r = await run_discovery(deps, {"sourceId": sid}, "d1", 1)
    assert r["failed"] and r["code"] == "SOURCE_NOT_APPROVED"


# ── publishing ───────────────────────────────────────────────────────────
async def test_publish_command_is_idempotent_and_paced(deps, sessions, world, tmp_path):
    aid = await insert_account(deps, SessionBlob(username="mypage", password="correct horse"))
    await sessions.login(aid)
    f = deps.storage / "processed" / "x.mp4"
    f.parent.mkdir(parents=True)
    make_video(f)
    ctl = SessionControl(deps.redis, sessions, deps.storage, "t")
    args = {"externalAccountId": "mypage", "containerId": "ig-session:abc", "kind": "REEL", "mediaType": "VIDEO", "filePath": str(f), "caption": "hello #x"}
    r1 = await ctl.execute("publish", args)
    r2 = await ctl.execute("publish", args)
    assert r1 == r2 and r1["permalink"].startswith("https://www.instagram.com/reel/")
    assert len(world.uploads) == 1 and world.uploads[0][2] == "hello #x"
    assert world.feed_loads == 1  # opened the feed before posting

    outside = tmp_path / "elsewhere.mp4"
    shutil.copyfile(f, outside)
    with pytest.raises(SessionError) as ei:
        await ctl.execute("publish", {**args, "containerId": "ig-session:def", "filePath": str(outside)})
    assert ei.value.code == "MEDIA_INVALID"
