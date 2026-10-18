"""Parallel mode: GPT-Live hears each Home Assistant turn once, whether a delegation claims it or not."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import numpy as np
import pytest
import virtual_time
from live_fakes import Connection, conversation
from voice_broker import live
from voice_broker.assist import HeardSpeech, HomeEvent, HomeTurn, Outcome
from voice_broker.live import Parallel

LIGHT = HomeTurn(1, Outcome.ACTED, "The light is on.", "turn on the light")
LIGHT_TOLD = "Home Assistant: The light is on."
TIME = "It is 14:05."
# The two pieces of one utterance Home Assistant heard with a gap in it.
CUT = [
    HomeTurn(turn, Outcome.FAILED, "", heard, reason="speech cut", gap=1) for turn, heard in ((1, "turn"), (2, "on"))
]


class Ears:
    """Home Assistant hearing the conversation; the test queues what it reports."""

    def __init__(self) -> None:
        self.events: asyncio.Queue[HomeEvent] = asyncio.Queue()

    def feed(self, pcm: np.ndarray, audible: bool) -> None:
        pass

    def user_heard(self, back_s: float | None, during: bool = False) -> None:
        pass

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass


class Agent:
    """Answers each consult once released."""

    def __init__(self) -> None:
        self.released = asyncio.Event()

    async def consult(self, task: str) -> str:
        await self.released.wait()
        return TIME


Scenario = Callable[[Connection, Ears, Agent], Awaitable[None]]


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


async def until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(60):
        while not condition():
            await asyncio.sleep(0.001)


def ask(conn: Connection) -> None:
    conn.user("Turn on the light, and what time is it?")
    conn.delegate("dlg_1")


async def no_delegation(conn: Connection, ears: Ears, agent: Agent) -> None:
    ears.events.put_nowait(HeardSpeech(1))
    ears.events.put_nowait(LIGHT)


async def claimed(conn: Connection, ears: Ears, agent: Agent) -> None:
    agent.released.set()
    ears.events.put_nowait(HeardSpeech(1))
    await settle()
    ask(conn)
    await settle()
    ears.events.put_nowait(LIGHT)


async def claimed_by_a_slow_agent(conn: Connection, ears: Ears, agent: Agent) -> None:
    ears.events.put_nowait(HeardSpeech(1))
    await settle()
    ask(conn)
    ears.events.put_nowait(LIGHT)
    await until(lambda: bool(conn.spoken))
    agent.released.set()


async def done_after_the_answer(conn: Connection, ears: Ears, agent: Agent) -> None:
    agent.released.set()
    ears.events.put_nowait(HeardSpeech(1))
    await settle()
    ask(conn)
    await until(lambda: bool(conn.spoken))
    ears.events.put_nowait(LIGHT)


async def cut_in_two(conn: Connection, ears: Ears, agent: Agent) -> None:
    for piece in CUT:
        ears.events.put_nowait(HeardSpeech(piece.turn))
        ears.events.put_nowait(piece)


def said(*parts: str) -> str:
    """One answer of `parts`, as GPT-Live is told it."""
    return " ".join(" ".join(parts).split())


@pytest.mark.parametrize(
    ("scenario", "spoken", "thought"),
    [
        (no_delegation, [LIGHT_TOLD], []),
        (claimed, [said(LIGHT_TOLD, TIME)], []),
        (claimed_by_a_slow_agent, [LIGHT_TOLD, TIME], []),
        (done_after_the_answer, [said(live._HOME_PENDING, TIME), LIGHT_TOLD], []),
        (cut_in_two, [], [live._HOME_FAILED.format(reason="speech cut")]),
    ],
)
def test_each_home_assistant_turn_is_told_once(scenario: Scenario, spoken, thought):
    ears, agent = Ears(), Agent()

    async def main() -> Connection:
        async with conversation(agent.consult, Parallel(ears)) as (conn, _):
            await scenario(conn, ears, agent)
            await until(lambda: len(conn.spoken) + len(conn.thought) >= len(spoken) + len(thought))
            # past every wait that could tell a turn a second time
            await asyncio.sleep(60)
        return conn

    conn = virtual_time.run(main())
    assert conn.spoken == spoken
    assert conn.thought == thought
