"""Home Assistant, hearing the conversation, acts on each request whole and once, never on the assistant's voice."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import numpy as np
import pytest
import virtual_time
from fake_home_assistant import PIPELINE, TOKEN, WORD_S, FakeHomeAssistant, speech
from voice_broker.assist import (
    HomeEvent,
    HomeListener,
    HomeTurn,
    Outcome,
    ToolPolicy,
    Unavailable,
)
from voice_broker.protocol import MIC_RATE

LIGHT = "turn on the kitchen light"
LIGHT_S = len(LIGHT.split()) * WORD_S
BLINDS = "open the blinds"
FAN = "switch off the fan"
# The assistant's words: the echo canceller leaves enough of them in the mic for speech recognition.
REPLY = "sure here is what i found about that"
BLOCK = MIC_RATE // 10


class Speaker:
    """A conversation at the kitchen speaker, its mic in real time."""

    def __init__(self, ha: FakeHomeAssistant, lock: asyncio.Lock) -> None:
        clock = asyncio.get_running_loop().time
        policy = ToolPolicy(frozenset(), frozenset())
        self.home = HomeListener(
            "http://ha.test:8123", TOKEN, PIPELINE, "kitchen", policy, lock, connector=ha.connect, clock=clock
        )
        self.home.start()

    async def silence(self, seconds: float) -> None:
        await self._play(np.zeros(round(seconds * MIC_RATE), dtype=np.int16), audible=False)

    async def assistant(self, seconds: float) -> None:
        await self._play(np.resize(speech(REPLY), round(seconds * MIC_RATE)), audible=True)

    async def say(self, text: str) -> None:
        await self._play(speech(text), audible=False)

    async def end(self) -> list[HomeEvent]:
        """Ends the conversation once its request under way is acted on; what Home Assistant reported."""
        if (finishing := self.home.stop()) is not None:
            await finishing
        events: list[HomeEvent] = []
        while not self.home.events.empty():
            events.append(self.home.events.get_nowait())
        return events

    async def _play(self, samples: np.ndarray, audible: bool) -> None:
        for start in range(0, len(samples), BLOCK):
            block = samples[start : start + BLOCK]
            # a block arrives once it has been heard
            await asyncio.sleep(len(block) / MIC_RATE)
            self.home.feed(block, audible)


Scenario = Callable[[Speaker, FakeHomeAssistant], Awaitable[None]]


def converse(scenario: Scenario, ha: FakeHomeAssistant | None = None) -> tuple[FakeHomeAssistant, list[HomeEvent]]:
    ha = ha or FakeHomeAssistant()

    async def main() -> list[HomeEvent]:
        speaker = Speaker(ha, asyncio.Lock())
        await scenario(speaker, ha)
        # long enough for Home Assistant to act on what it heard
        await speaker.silence(10)
        return await speaker.end()

    events = virtual_time.run(main())
    assert ha.violations == []
    return ha, events


def turns(events: list[HomeEvent]) -> list[HomeTurn]:
    return [event for event in events if isinstance(event, HomeTurn)]


@pytest.mark.parametrize("silence_s", [0.0, 3.0, 5.6, 5.75, 5.8, 6.1, 6.9, 7.3, 12.5, 13.2, 14.0, 40.0])
def test_a_request_after_any_silence_is_acted_on_whole_once(silence_s):
    async def scenario(speaker: Speaker, ha: FakeHomeAssistant) -> None:
        await speaker.silence(silence_s)
        await speaker.say(LIGHT)

    ha, _ = converse(scenario)
    assert ha.acted_on == [LIGHT]


def test_silence_is_never_acted_on():
    ha, events = converse(lambda speaker, ha: speaker.silence(60))
    assert ha.acted_on == []
    assert events == []


@pytest.mark.parametrize("intent_s", [1.0, 5.0], ids=["after the first is acted on", "while it is acted on"])
def test_requests_in_a_row_are_each_acted_on_whole_in_order(intent_s):
    async def scenario(speaker: Speaker, ha: FakeHomeAssistant) -> None:
        await speaker.say(LIGHT)
        await speaker.silence(1)
        await speaker.say(BLINDS)

    ha, _ = converse(scenario, FakeHomeAssistant(intent_s))
    assert ha.acted_on == [LIGHT, BLINDS]


@pytest.mark.parametrize("reply_s", [3.0, 25.0, 44.0, 50.0, 57.0, 59.0, 65.0])
def test_a_request_after_a_reply_of_any_length_is_acted_on_and_the_reply_never(reply_s):
    async def scenario(speaker: Speaker, ha: FakeHomeAssistant) -> None:
        await speaker.silence(1)
        await speaker.assistant(reply_s)
        await speaker.silence(1)
        await speaker.say(LIGHT)

    ha, _ = converse(scenario)
    assert ha.acted_on == [LIGHT]


@pytest.mark.parametrize("pause_s", [0.2, 3.0])
def test_an_acknowledgment_right_after_a_request_is_never_acted_on_and_cuts_nothing(pause_s):
    async def scenario(speaker: Speaker, ha: FakeHomeAssistant) -> None:
        await speaker.say(LIGHT)
        # before Home Assistant has heard the request end
        await speaker.silence(0.3)
        await speaker.assistant(1)
        await speaker.silence(pause_s)
        await speaker.say(BLINDS)

    ha, _ = converse(scenario)
    assert ha.acted_on == [LIGHT, BLINDS]


@pytest.mark.parametrize(
    ("dropped_after_s", "outcome", "acted_on"),
    # Every 0.1 s until Home Assistant has the request's transcript, 1 s after it ends: where the drop lands in the
    # audio decides what is left of it. Then while its agent decides, which the drop cancels, and while its tool
    # call runs, which finishes.
    [(tenth / 10, Outcome.FAILED, [BLINDS]) for tenth in range(round((LIGHT_S + 1) * 10))]
    + [(LIGHT_S + 1.5, Outcome.UNCERTAIN, [BLINDS]), (LIGHT_S + 2.1, Outcome.UNCERTAIN, [LIGHT, BLINDS])],
)
def test_a_request_cut_by_a_lost_connection_is_never_acted_on_in_part_nor_twice(dropped_after_s, outcome, acted_on):
    """The connection drops `dropped_after_s` after the request begins."""

    async def scenario(speaker: Speaker, ha: FakeHomeAssistant) -> None:
        await speaker.silence(1)
        asyncio.get_running_loop().call_later(dropped_after_s, ha.drop_connections)
        await speaker.say(LIGHT)
        await speaker.silence(3)
        await speaker.say(BLINDS)

    ha, events = converse(scenario)
    assert ha.acted_on == acted_on
    assert turns(events)[0].outcome == outcome


def test_home_assistant_gone_for_good_is_reported_once():
    async def scenario(speaker: Speaker, ha: FakeHomeAssistant) -> None:
        await speaker.silence(1)
        ha.down = True
        ha.drop_connections()
        await speaker.say(LIGHT)

    ha, events = converse(scenario)
    assert ha.acted_on == []
    assert [type(event) for event in events] == [Unavailable]


@pytest.mark.parametrize(
    ("ended_after_s", "silence_s", "acted_on"),
    [(0.5, 0.0, [BLINDS, FAN]), (2.0, 0.0, [LIGHT, BLINDS, FAN]), (2.0, 4.8, [LIGHT, BLINDS, FAN])],
    ids=[
        "before Home Assistant has the request",
        "while Home Assistant acts on it",
        "said as the waiting audio fills a run",
    ],
)
def test_a_new_conversation_at_the_speaker_waits_for_the_last_ones_request(ended_after_s, silence_s, acted_on):
    """Requests said meanwhile reach Home Assistant at once when the last one is done."""
    ha = FakeHomeAssistant(intent_s=8)

    async def main() -> None:
        lock = asyncio.Lock()
        first = Speaker(ha, lock)
        await first.say(LIGHT)
        # The conversation ends this long after the request, and the next begins at once.
        await first.silence(ended_after_s)
        ending = asyncio.ensure_future(first.end())
        second = Speaker(ha, lock)
        await second.silence(silence_s)
        await second.say(BLINDS)
        await second.silence(1)
        await second.say(FAN)
        await second.silence(15)
        await ending
        await second.end()

    virtual_time.run(main())
    assert ha.acted_on == acted_on
    assert ha.violations == []
