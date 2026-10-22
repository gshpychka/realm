"""The idle end at hoard's 3 s, on a fake clock: no device, no Live session, no audio, no real waiting."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from types import SimpleNamespace

import numpy as np
from voice_broker import conversation as conversation_module
from voice_broker._aec import EchoCanceller
from voice_broker.conversation import Conversation, EndReason
from voice_broker.protocol import MIC_RATE, SPEAKER_RATE

# hoard's idle_timeout_s (machines/hoard/voice-broker.nix)
IDLE_S = 3.0
# The watchdog's poll interval.
POLL_S = 0.5
# What a conversation reads of the config: no cap reached, no recordings.
CONFIG = SimpleNamespace(idle_timeout_s=IDLE_S, max_conversation_s=600.0, recordings_dir=None)


class Clock:
    """Advances only when the watchdog sleeps, running each scheduled change once its time is reached."""

    def __init__(self) -> None:
        self.t = 0.0
        self._changes: list[tuple[float, Callable[[], None]]] = []

    def schedule(self, changes: list[tuple[float, Callable[[], None]]]) -> None:
        self._changes = sorted(changes, key=lambda change: change[0])

    def monotonic(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.t += seconds
        while self._changes and self._changes[0][0] <= self.t:
            self._changes.pop(0)[1]()


class Session:
    busy = False
    hearing = False


class Device:
    """Never read or written: only the watchdog runs."""

    async def send(self, message: str | bytes) -> None:
        raise AssertionError("the watchdog sent to the device")

    async def close(self) -> None:
        raise AssertionError("the watchdog closed the device")

    def __aiter__(self):
        raise AssertionError("the watchdog read the device")


def run_watchdog(monkeypatch, changes, session=None, setup=None) -> tuple[float, EndReason | None]:
    session = session or Session()
    clock = Clock()
    monkeypatch.setattr(conversation_module, "time", SimpleNamespace(monotonic=clock.monotonic))
    conversation = Conversation(
        CONFIG,
        "test",
        Device(),
        session,
        EchoCanceller(MIC_RATE),
    )
    if setup:
        setup(conversation)
    clock.schedule(changes(conversation))
    monkeypatch.setattr(conversation_module, "asyncio", SimpleNamespace(sleep=clock.sleep))
    asyncio.run(conversation._watchdog(0.0))
    return clock.t, conversation.end_reason


def test_the_conversation_ends_3s_after_the_last_activity(monkeypatch):
    # Activity less than 3 s apart (a reply finished playing, say) keeps it open; the last one, at 4 s, counts.
    ended, reason = run_watchdog(monkeypatch, lambda c: [(2.0, c.mark_activity), (4.0, c.mark_activity)])
    assert reason == EndReason.IDLE
    # Not at 3 s exactly, by the next poll after it.
    assert 4.0 + IDLE_S < ended <= 4.0 + IDLE_S + POLL_S


def test_backend_work_holds_the_conversation_open_past_3s(monkeypatch):
    session = Session()
    session.busy = True

    def changes(c: Conversation) -> list[tuple[float, Callable[[], None]]]:
        def result_told() -> None:
            # As live.py does when a delegation's result is told.
            session.busy = False
            c.mark_activity()

        return [(20.0, result_told)]

    ended, reason = run_watchdog(monkeypatch, changes, session)
    assert reason == EndReason.IDLE
    assert 20.0 + IDLE_S < ended <= 20.0 + IDLE_S + POLL_S


def test_speech_still_on_its_way_to_live_holds_the_conversation_open_past_3s(monkeypatch):
    session = Session()
    session.hearing = True

    def heard() -> None:
        session.hearing = False

    ended, reason = run_watchdog(monkeypatch, lambda c: [(20.0, heard)], session)
    assert reason == EndReason.IDLE
    # The watchdog marked activity at its last poll while hearing, just before 20 s.
    assert 20.0 - POLL_S + IDLE_S < ended <= 20.0 + IDLE_S + POLL_S


def test_reply_audio_still_queued_holds_the_conversation_open_past_3s(monkeypatch):
    def queue_reply(c: Conversation) -> None:
        # One loud second, never sent: the device plays nothing, so it stays audible.
        c.play(np.full(SPEAKER_RATE, 8000, dtype=np.int16))
        assert c.assistant_audible

    def changes(c: Conversation) -> list[tuple[float, Callable[[], None]]]:
        def played_out() -> None:
            c._take_pending(c._pending_samples)
            assert not c.assistant_audible
            # As the pump does when the reply finishes playing.
            c.mark_activity()

        return [(20.0, played_out)]

    ended, reason = run_watchdog(monkeypatch, changes, setup=queue_reply)
    assert reason == EndReason.IDLE
    assert 20.0 + IDLE_S < ended <= 20.0 + IDLE_S + POLL_S
