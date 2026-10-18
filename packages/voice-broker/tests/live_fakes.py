"""A LiveSession on a scripted GPT-Live connection."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace

import numpy as np
from voice_broker.config import Live
from voice_broker.live import Consult, LiveSession, Mode
from voice_broker.openclaw import Turn
from voice_broker.protocol import Phase


class Host:
    assistant_audible = False

    def play(self, samples: np.ndarray) -> None:
        pass

    async def set_phase(self, phase: Phase) -> None:
        pass

    def mark_activity(self) -> None:
        pass


class Connection:
    """A scripted Live connection: its events are queued by the test, what it is told recorded."""

    def __init__(self) -> None:
        self.events: asyncio.Queue[SimpleNamespace | None] = asyncio.Queue()
        self.spoken: list[str] = []
        self.thought: list[str] = []
        self.clock_ms = 0
        self.session = SimpleNamespace(
            start=self._start,
            input_audio=SimpleNamespace(append=self._ignore),
            commentary=SimpleNamespace(append=self._comment),
            thinking=SimpleNamespace(append=self._think),
        )

    async def _start(self, session: dict) -> None:
        await self.events.put(SimpleNamespace(type="session.started"))

    async def _ignore(self, **kwargs) -> None:
        pass

    async def _comment(self, content: str, delegation_id: str | None) -> None:
        self.spoken.append(content)

    async def _think(self, content: str, delegation_id: str | None) -> None:
        self.thought.append(content)

    def user(self, text: str, start_ms: int | None = None) -> None:
        self.clock_ms += 100
        start = self.clock_ms if start_ms is None else start_ms
        self.events.put_nowait(
            SimpleNamespace(type="session.input_transcript.delta", delta=text, start_ms=start, end_ms=start + 100)
        )

    def delegate(self, delegation_id: str) -> None:
        self.clock_ms += 100
        self.events.put_nowait(
            SimpleNamespace(
                type="session.delegation.created", delegation=SimpleNamespace(id=delegation_id), offset_ms=self.clock_ms
            )
        )

    def __aiter__(self):
        return self

    async def __anext__(self):
        event = await self.events.get()
        if event is None:
            raise StopAsyncIteration
        return event


async def nothing_recent() -> list[Turn]:
    return []


@asynccontextmanager
async def conversation(consult: Consult, mode: Mode) -> AsyncIterator[tuple[Connection, LiveSession]]:
    """A conversation at the kitchen speaker, open while the block runs."""
    conn = Connection()

    @asynccontextmanager
    async def connect():
        yield conn

    live = Live(model="gpt-live-1", voice="marin", instructions="")
    session = LiveSession(live, "Kitchen", consult, nothing_recent, connect, None, mode)
    async with session.open(Host()):
        receiving = asyncio.create_task(session.receive())
        yield conn, session
        await conn.events.put(None)
        await receiving
