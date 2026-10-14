"""Child-process management for the proxy runtime.

Only an explicit argv list is ever executed (never a shell). Commands that
change machine-wide networking are rejected outright as a last line of defence.
"""

from __future__ import annotations

import asyncio
import os
import signal
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from .redaction import redact_string

# Programs that alter global network state. ReelFlow must never run them.
FORBIDDEN_PROGRAMS = frozenset({"networksetup", "route", "scutil", "ifconfig", "pfctl", "launchctl", "sudo", "ipconfig", "dscacheutil"})


class ForbiddenCommandError(RuntimeError):
    pass


def assert_allowed(argv: list[str]) -> None:
    if not argv:
        raise ForbiddenCommandError("empty command")
    program = Path(argv[0]).name
    if program in FORBIDDEN_PROGRAMS:
        raise ForbiddenCommandError(f"{program} changes global network configuration and is never run by ReelFlow")
    for a in argv:
        if "\0" in a:
            raise ForbiddenCommandError("NUL byte in argument")


@dataclass
class ProcessRunner:
    """Runs one long-lived child process and keeps a bounded tail of its output."""

    argv: list[str]
    cwd: Path | None = None
    env: dict[str, str] | None = None
    max_log_lines: int = 200
    _proc: asyncio.subprocess.Process | None = field(default=None, init=False)
    _tail: deque[str] = field(default_factory=lambda: deque(maxlen=200), init=False)
    _reader: asyncio.Task[None] | None = field(default=None, init=False)

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc else None

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode if self._proc else None

    def output_tail(self, lines: int = 20) -> list[str]:
        return list(self._tail)[-lines:]

    async def start(self) -> None:
        if self.running:
            return
        assert_allowed(self.argv)
        self._tail.clear()
        # start_new_session → own process group, so stop() can terminate children too.
        self._proc = await asyncio.create_subprocess_exec(
            *self.argv,
            cwd=str(self.cwd) if self.cwd else None,
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        self._reader = asyncio.create_task(self._read_output())

    async def _read_output(self) -> None:
        assert self._proc and self._proc.stdout
        while line := await self._proc.stdout.readline():
            self._tail.append(redact_string(line.decode(errors="replace").rstrip()))

    async def stop(self, timeout: float = 8.0) -> None:
        """SIGTERM the process group, then SIGKILL if it does not exit in time.

        Always signals the group even if the tracked process itself has
        already exited: a tool like sshpass can exit once auth succeeds while
        the ssh it forked keeps running in the same group — the group id stays
        valid as long as any member is alive, so killpg still reaches it even
        though we can no longer wait() on something that is not our child.
        """
        if not self._proc:
            return
        try:
            os.killpg(self._proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if self._proc.returncode is None:
            try:
                await asyncio.wait_for(self._proc.wait(), timeout)
            except TimeoutError:
                pass
        try:
            os.killpg(self._proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if self._proc.returncode is None:
            await self._proc.wait()
        if self._reader:
            # The tracked process is dead, but a grandchild it forked (e.g. sshpass's
            # own ssh child, if it ever escapes the process group) could still hold
            # the stdout pipe open, leaving readline() blocked forever — never let
            # that wedge the caller. Cancelling just stops our reader; it does not
            # touch the process.
            try:
                await asyncio.wait_for(asyncio.shield(self._reader), timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                self._reader.cancel()
                await asyncio.gather(self._reader, return_exceptions=True)
        self._reader = None

    async def wait(self) -> int:
        assert self._proc
        return await self._proc.wait()
