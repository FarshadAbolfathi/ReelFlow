"""Real-socket fixtures: an HTTP target and a minimal HTTP/CONNECT proxy."""

from __future__ import annotations

import asyncio
import socket
import sys
import textwrap
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Target:
    port: int
    hits: list[str] = field(default_factory=list)

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"


async def _read_head(reader: asyncio.StreamReader) -> bytes:
    return await reader.readuntil(b"\r\n\r\n")


@pytest.fixture
async def target() -> AsyncIterator[Target]:
    t = Target(port=0)

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await _read_head(reader)
        except (asyncio.IncompleteReadError, ConnectionError):
            writer.close()
            return
        target_path = head.split(b" ")[1].decode()
        path = "/" + target_path.split("/", 3)[3] if target_path.startswith("http") else target_path
        t.hits.append(path)
        if path.startswith("/slow"):
            await asyncio.sleep(3)
        status, body = ("204 No Content", b"") if path == "/generate_204" else ("200 OK", f"hello {path}".encode())
        writer.write(f"HTTP/1.1 {status}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    t.port = server.sockets[0].getsockname()[1]
    yield t
    server.close()


@dataclass
class FakeProxy:
    port: int
    requests: list[str] = field(default_factory=list)
    server: asyncio.base_events.Server | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


async def start_fake_proxy(port: int = 0) -> FakeProxy:
    p = FakeProxy(port=port)

    async def pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        try:
            while data := await r.read(65536):
                w.write(data)
                await w.drain()
        except ConnectionError:
            pass
        finally:
            w.close()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await _read_head(reader)
        except (asyncio.IncompleteReadError, ConnectionError):
            writer.close()
            return
        line = head.split(b"\r\n", 1)[0].decode()
        method, target, _ = line.split(" ", 2)
        p.requests.append(line)
        if method == "CONNECT":
            host, port_s = target.rsplit(":", 1)
            ur, uw = await asyncio.open_connection(host, int(port_s))
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
        else:
            hostport = target.split("/")[2]
            host, port_s = hostport.rsplit(":", 1) if ":" in hostport else (hostport, "80")
            ur, uw = await asyncio.open_connection(host, int(port_s))
            uw.write(head)
            await uw.drain()
        await asyncio.gather(pipe(reader, uw), pipe(ur, writer))

    p.server = await asyncio.start_server(handle, "127.0.0.1", port)
    p.port = p.server.sockets[0].getsockname()[1]
    return p


@pytest.fixture
async def fake_proxy() -> AsyncIterator[FakeProxy]:
    p = await start_fake_proxy()
    yield p
    assert p.server
    p.server.close()


def make_fake_singbox(runtime: Path, port: int, *, behaviour: str = "listen") -> Path:
    """Creates runtime/bin/sing-box: a Python stand-in that behaves like the real binary
    ('listen' opens the port, 'crash' exits with an error, 'stubborn' ignores SIGTERM)."""
    (runtime / "bin").mkdir(parents=True, exist_ok=True)
    script = runtime / "bin" / "sing-box"
    script.write_text(
        textwrap.dedent(
            f"""\
            #!{sys.executable}
            import signal, socket, sys, time
            mode = {behaviour!r}
            if mode == "crash":
                print("FATAL[0000] start service: initialize inbound[0]: listen tcp 127.0.0.1:{port}: bind: address already in use", flush=True)
                sys.exit(1)
            if mode == "stubborn":
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
            s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", {port})); s.listen(16)
            print("INFO[0000] sing-box started (fake)", flush=True)
            while True:
                time.sleep(0.2)
            """
        )
    )
    script.chmod(0o755)
    (runtime / "config_proxy.json").write_text(
        '{"inbounds":[{"type":"mixed","tag":"in","listen":"127.0.0.1","listen_port":%d}],"outbounds":[{"type":"direct"}]}' % port
    )
    return script
