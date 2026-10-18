"""Gated delegation: a request runs once, on the backend its whole text is classified to, or not at all."""

from __future__ import annotations

import asyncio

from live_fakes import Connection, conversation
from voice_broker.home_assistant import HomeAssistantFailed, HomeReply
from voice_broker.live import _APPEND_MAX_BYTES, LiveSession, Routed, _chunks
from voice_broker.routing import RouteDecision, RouteRequest, RoutingFailed


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


def run(script, backends: Backends, route=None) -> Connection:
    async def main() -> Connection:
        routed = Routed(route or backends.route, backends.converse, 60.0, settle_s=0.01)
        async with conversation(backends.consult, routed) as (conn, session):
            await script(conn, session)
            await idle(session)
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
