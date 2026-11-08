"""The Hermes adapter: one bridge request per consult, history within the configured bounds."""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from unix_http import Request, serve
from voice_broker import hermes as hermes_module
from voice_broker.agent import ConsultFailed, HistoryUnavailable
from voice_broker.config import Hermes as HermesConfig
from voice_broker.config import History
from voice_broker.hermes import Hermes


@pytest.fixture
def socket() -> Iterator[Path]:
    # A Unix socket path is limited to 108 bytes, which pytest's tmp_path can pass.
    directory = Path(tempfile.mkdtemp(prefix="vb"))
    yield directory / "agent.sock"
    shutil.rmtree(directory)


def config(socket: Path, **history: Any) -> HermesConfig:
    bounds = {"max_messages": 40, "max_age_s": 3600.0, "max_chars": 8000, **history}
    return HermesConfig(socket=socket, instructions="Answer briefly.", history=History(**bounds))


def run(coroutine):
    return asyncio.run(coroutine)


def answering(status: int, body: Any):
    async def respond(request: Request):
        return status, body

    return respond


def test_a_consult_is_one_bridge_request(socket: Path):
    async def scenario():
        async with serve(socket, answering(200, {"text": "  It is noon.  "})) as requests:
            agent = Hermes(config(socket))
            try:
                answer = await agent.conversation("kitchen-1").consult("What time is it?")
            finally:
                await agent.aclose()
        return answer, requests

    answer, requests = run(scenario())
    assert answer == "It is noon."
    (request,) = requests
    assert (request.method, request.path) == ("POST", "/consult")
    assert request.body["task"] == "What time is it?"
    assert request.body["instructions"] == "Answer briefly."
    assert request.body["submission_id"]


def test_each_consult_has_its_own_submission_id(socket: Path):
    async def scenario():
        async with serve(socket, answering(200, {"text": "ok"})) as requests:
            agent = Hermes(config(socket))
            try:
                conversation = agent.conversation("kitchen-1")
                await conversation.consult("one")
                await conversation.consult("two")
                await agent.conversation("kitchen-2").consult("three")
            finally:
                await agent.aclose()
        return requests

    ids = [r.body["submission_id"] for r in run(scenario())]
    assert len(set(ids)) == 3


@pytest.mark.parametrize(
    "status, body",
    [
        (504, {"error": "uncertain"}),
        (502, {"error": "interrupted"}),
        (503, {"error": "no_session"}),
        (200, {"text": ""}),
        (200, {"text": "   "}),
        (200, {"text": 42}),
        (200, {"answer": "ok"}),
        (200, b"not json"),
    ],
)
def test_a_consult_without_an_answer_fails_once(socket: Path, status: int, body: Any):
    async def scenario():
        async with serve(socket, answering(status, body)) as requests:
            agent = Hermes(config(socket))
            try:
                with pytest.raises(ConsultFailed):
                    await agent.conversation("kitchen-1").consult("Turn on the kettle.")
            finally:
                await agent.aclose()
        return requests

    # Never sent again: the turn may have run.
    assert len(run(scenario())) == 1


def test_a_lost_answer_is_not_retried(socket: Path):
    async def hang_up(request: Request):
        return None

    async def scenario():
        async with serve(socket, hang_up) as requests:
            agent = Hermes(config(socket))
            try:
                with pytest.raises(ConsultFailed):
                    await agent.conversation("kitchen-1").consult("Turn on the kettle.")
            finally:
                await agent.aclose()
        return requests

    assert len(run(scenario())) == 1


def test_a_consult_times_out_once(socket: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(hermes_module, "_CONSULT_TIMEOUT_S", 0.2)

    async def never(request: Request):
        await asyncio.sleep(5)
        return 200, {"text": "late"}

    async def scenario():
        async with serve(socket, never) as requests:
            agent = Hermes(config(socket))
            try:
                with pytest.raises(ConsultFailed):
                    await agent.conversation("kitchen-1").consult("Turn on the kettle.")
            finally:
                await agent.aclose()
        return requests

    assert len(run(scenario())) == 1


def test_no_bridge_is_a_failed_consult(socket: Path):
    async def scenario():
        agent = Hermes(config(socket))
        try:
            with pytest.raises(ConsultFailed):
                await agent.conversation("kitchen-1").consult("hello")
            with pytest.raises(HistoryUnavailable):
                await agent.conversation("kitchen-1").recent()
        finally:
            await agent.aclose()

    run(scenario())


def test_history_is_bounded_like_openclaws(socket: Path):
    now = time.time()
    messages = [
        {"role": "user", "text": "an hour and more ago", "timestamp": now - 4000},
        {"role": "assistant", "text": "dropped by age", "timestamp": now - 3700},
        {"role": "user", "text": "x" * 50, "timestamp": now - 300},
        {"role": "tool", "text": "a tool result", "timestamp": now - 250},
        {"role": "user", "text": "  What's the weather?  ", "timestamp": now - 200},
        {"role": "assistant", "text": "", "timestamp": now - 150},
        {"role": "assistant", "text": None, "timestamp": now - 140},
        {"role": "assistant", "text": "Sunny.", "timestamp": now - 100},
        {"role": "user", "text": "Thanks", "timestamp": None},
    ]

    async def scenario(**bounds: Any):
        async with serve(socket, answering(200, {"messages": messages})) as requests:
            agent = Hermes(config(socket, **bounds))
            try:
                turns = await agent.conversation("kitchen-1").recent()
            finally:
                await agent.aclose()
        return turns, requests

    turns, requests = run(scenario(max_chars=40))
    # The 50 characters would pass the bound: only the tail after them is kept.
    assert turns == [("user", "What's the weather?"), ("assistant", "Sunny."), ("user", "Thanks")]
    (request,) = requests
    assert (request.method, request.path, request.query) == ("GET", "/history", {"limit": ["40"]})

    # The bridge's newest max_messages messages at most, whatever it sends.
    turns, _ = run(scenario(max_messages=3))
    assert turns == [("assistant", "Sunny."), ("user", "Thanks")]

    turns, _ = run(scenario())
    assert turns[0] == ("user", "x" * 50)


@pytest.mark.parametrize("bounds", [{"max_messages": 0}, {"max_chars": 0}])
def test_no_history_budget_reads_nothing(socket: Path, bounds: dict[str, int]):
    async def scenario():
        async with serve(socket, answering(200, {"messages": []})) as requests:
            agent = Hermes(config(socket, **bounds))
            try:
                turns = await agent.conversation("kitchen-1").recent()
            finally:
                await agent.aclose()
        return turns, requests

    assert run(scenario()) == ([], [])


@pytest.mark.parametrize(
    "status, body", [(503, {"error": "no_session"}), (200, {"messages": "none"}), (200, {}), (200, b"<html>")]
)
def test_unreadable_history_is_unavailable(socket: Path, status: int, body: Any):
    async def scenario():
        async with serve(socket, answering(status, body)):
            agent = Hermes(config(socket))
            try:
                with pytest.raises(HistoryUnavailable):
                    await agent.conversation("kitchen-1").recent()
            finally:
                await agent.aclose()

    run(scenario())
