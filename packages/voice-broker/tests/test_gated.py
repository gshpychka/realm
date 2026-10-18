"""Gated delegation: a request runs once, on the backend its whole text is classified to, or not at all."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import numpy as np
from voice_broker.config import Live
from voice_broker.home_assistant import HomeAssistantFailed, HomeReply
from voice_broker.live import _APPEND_MAX_BYTES, LiveSession, Routed, _chunks
from voice_broker.openclaw import Turn
from voice_broker.protocol import Phase
from voice_broker.routing import RouteDecision, RouteRequest, RoutingFailed


class Host:
    assistant_audible = False

    def play(self, samples: np.ndarray) -> None:
        pass

    async def set_phase(self, phase: Phase) -> None:
        pass

    def mark_activity(self) -> None:
        pass


class Connection:
    """A scripted Live connection: its events are queued by the test, its commentary recorded."""

    def __init__(self) -> None:
        self.events: asyncio.Queue[SimpleNamespace | None] = asyncio.Queue()
        self.spoken: list[str] = []
        self.clock_ms = 0
        self.session = SimpleNamespace(
            start=self._start,
            input_audio=SimpleNamespace(append=self._ignore),
            commentary=SimpleNamespace(append=self._comment),
        )

    async def _start(self, session: dict) -> None:
        await self.events.put(SimpleNamespace(type="session.started"))

    async def _ignore(self, **kwargs) -> None:
        pass

    async def _comment(self, content: str, delegation_id: str | None) -> None:
        self.spoken.append(content)

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


class Backends:
    """Records every classification and backend call; answers from scripts."""

    def __init__(self, routes, home_replies=()) -> None:
        self.routes = list(routes)
        self.home_replies = list(home_replies)
        self.requests: list[str] = []
        self.home: list[str] = []
        self.tasks: list[str] = []

    async def route(self, request: RouteRequest) -> RouteDecision:
        self.requests.append(request.text)
        route = self.routes.pop(0)
        if isinstance(route, Exception):
            raise route
        return RouteDecision(route, 0.9, 1.0)

    async def converse(self, text: str, conversation_id: str | None) -> HomeReply:
        self.home.append(text)
        reply = self.home_replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    async def consult(self, task: str) -> str:
        self.tasks.append(task)
        return "Done."


async def nothing_recent() -> list[Turn]:
    return []


def run(script, backends: Backends, route=None) -> Connection:
    async def main() -> Connection:
        conn = Connection()

        @asynccontextmanager
        async def connect():
            yield conn

        routed = Routed(route or backends.route, backends.converse, 60.0, settle_s=0.01)
        live = Live(model="gpt-live-1", voice="marin", instructions="")
        session = LiveSession(live, "Kitchen", backends.consult, nothing_recent, connect, None, routed)
        async with session.open(Host()):
            receiving = asyncio.create_task(session.receive())
            await script(conn, session)
            await idle(session)
            await conn.events.put(None)
            await receiving
        return conn

    return asyncio.run(main())


async def idle(session: LiveSession) -> None:
    for _ in range(5):
        await asyncio.sleep(0)
    while session.busy:
        await asyncio.sleep(0.005)


def test_a_classifier_failure_runs_nothing():
    for failure in (RoutingFailed("PermissionDeniedError"), RuntimeError("bug")):
        backends = Backends(routes=[failure])

        async def script(conn: Connection, session: LiveSession) -> None:
            conn.user("Turn off the lights.")
            conn.delegate("dlg_1")

        conn = run(script, backends)
        assert conn.spoken[0].startswith("Nothing was done")
        assert backends.home == [] and backends.tasks == []


def test_a_failed_home_request_is_never_run_again():
    backends = Backends(
        routes=["ha", "ha"], home_replies=[HomeAssistantFailed("TimeoutError"), HomeReply("It is.", None, False)]
    )

    async def script(conn: Connection, session: LiveSession) -> None:
        conn.user("Turn on the light.")
        conn.delegate("dlg_1")
        await idle(session)
        conn.user("Is it on?")
        conn.delegate("dlg_2")

    conn = run(script, backends)
    assert "may have acted" in conn.spoken[0]
    assert backends.home == ["Turn on the light.", "Is it on?"]


def test_a_transcript_trailing_the_classification_is_routed_whole():
    backends = Backends(routes=["ha", "openclaw"])
    routed_once = asyncio.Event()

    async def route(request: RouteRequest) -> RouteDecision:
        decision = await backends.route(request)
        routed_once.set()
        # the rest of the utterance, spoken before the delegation, is transcribed now
        await asyncio.sleep(0.02)
        return decision

    async def script(conn: Connection, session: LiveSession) -> None:
        conn.user("Turn off the kitchen light", start_ms=100)
        conn.delegate("dlg_1")
        await routed_once.wait()
        conn.user(" and tell me if it'll rain.", start_ms=150)

    run(script, backends, route)
    assert backends.requests == [
        "Turn off the kitchen light",
        "Turn off the kitchen light and tell me if it'll rain.",
    ]
    assert backends.home == [] and len(backends.tasks) == 1


def test_an_answer_reaches_live_in_appends_it_takes():
    text = "Світло на кухні увімкнено, а завтра обіцяють дощ. " * 40
    chunks = _chunks(text)
    assert all(len(chunk.encode()) <= _APPEND_MAX_BYTES for chunk in chunks)
    assert " ".join(chunks) == " ".join(text.split())
