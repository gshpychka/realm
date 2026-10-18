"""Home Assistant never hears the assistant's voice as a command, and hears the user speaking over it."""

import asyncio

import numpy as np
from voice_broker.assist import HomeListener, ToolPolicy
from voice_broker.protocol import MIC_RATE

BLOCK = MIC_RATE // 10
ECHO = 1000
USER = 3000
QUIET = 7


class Speaker:
    """A conversation feeding a listener 100 ms blocks on a clock of its own."""

    def __init__(self) -> None:
        self.now = 0.0
        policy = ToolPolicy(frozenset(), frozenset())
        self.home = HomeListener(
            "http://ha.test", "token", "pipeline", "device", policy, asyncio.Lock(), clock=lambda: self.now
        )

    def feed(self, value: int, seconds: float, audible: bool) -> None:
        for _ in range(round(seconds * 10)):
            self.home.feed(np.full(BLOCK, value, dtype=np.int16), audible)
            self.now += 0.1

    def heard(self) -> np.ndarray:
        """The audio queued for Home Assistant's speech recognition."""
        return np.concatenate([frame.pcm for frame in self.home._queue])


def test_the_assistants_voice_never_reaches_home_assistant():
    speaker = Speaker()
    speaker.feed(ECHO, 3, audible=True)
    speaker.feed(QUIET, 3, audible=False)
    heard = speaker.heard()
    assert ECHO not in heard
    assert np.count_nonzero(heard == QUIET) > 0


def test_the_user_speaking_over_the_assistant_reaches_home_assistant_whole():
    speaker = Speaker()
    speaker.feed(ECHO, 2, audible=True)
    speaker.feed(USER, 1, audible=True)
    speaker.home.user_heard(1.0, during=True)
    speaker.feed(QUIET, 3, audible=False)
    assert np.count_nonzero(speaker.heard() == USER) == MIC_RATE
