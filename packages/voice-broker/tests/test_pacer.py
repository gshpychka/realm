"""Mic audio reaches Live in order, never as a burst, and bounded."""

import asyncio

import numpy as np
import pytest
from voice_broker.live import MicOverflow, _MicPacer

RATE = 24000
PIECE = RATE // 10
SPEED = 1.2
AHEAD_S = 0.25
# the most audio that may reach Live at one instant: the lead and one piece
BURST = int(RATE * SPEED * AHEAD_S) + PIECE


def test_a_backlog_and_a_stalled_send_never_reach_live_as_a_burst():
    audio = np.arange(RATE * 10)

    async def main() -> list[tuple[float, np.ndarray]]:
        clock = [0.0]
        sent: list[tuple[float, np.ndarray]] = []

        async def sleep(seconds: float) -> None:
            clock[0] += seconds
            await asyncio.sleep(0)

        async def send(samples: np.ndarray) -> None:
            if len(sent) == 6:
                # Live stalls on this piece
                clock[0] += 5
            await asyncio.sleep(0)
            sent.append((clock[0], samples))

        pacer = _MicPacer(RATE, RATE * 15, SPEED, AHEAD_S, PIECE, clock=lambda: clock[0], sleep=sleep)
        pacer.put(audio)
        pacer.start(send)
        await pacer.drained()
        await pacer.close()
        return sent

    sent = asyncio.run(main())
    assert np.array_equal(np.concatenate([samples for _, samples in sent]), audio)
    at: dict[float, int] = {}
    for t, samples in sent:
        at[t] = at.get(t, 0) + len(samples)
    assert max(at.values()) <= BURST


def test_audio_past_the_bound_ends_the_conversation_instead_of_dropping_any():
    pacer = _MicPacer(RATE, RATE)
    pacer.put(np.zeros(RATE, dtype=np.int16))
    with pytest.raises(MicOverflow):
        pacer.put(np.zeros(1, dtype=np.int16))
