"""The aligner puts played audio at the mic sample where the DAC emitted it."""

import numpy as np
from voice_broker.alignment import Aligner
from voice_broker.protocol import MIC_RATE, SPEAKER_RATE, MicFrame, PlayedReport

US = 1_000_000
# esp_timer at the first mic sample
T0 = 5_000_000
MIC_CHUNK = MIC_RATE * 16 // 1000


def mic_frame(first: int, jitter_us: int = 0) -> MicFrame:
    return MicFrame(first, T0 + first * US // MIC_RATE + jitter_us, np.zeros(MIC_CHUNK, dtype=np.int16).tobytes())


def reference(played_at_mic: int, audio16: np.ndarray, report_jitter_us: int = 0) -> np.ndarray:
    """1 s of reference, for a playback of `audio16` whose first sample left the DAC at mic index `played_at_mic`."""
    aligner = Aligner()
    aligner.add_sent(len(audio16) * SPEAKER_RATE // MIC_RATE, audio16)
    rng = np.random.default_rng(0)
    reported = 0
    blocks = []
    for first in range(0, MIC_RATE, MIC_CHUNK):
        # capture timestamps are late by up to 3 ms of scheduling delay
        aligner.add_mic(mic_frame(first, int(rng.integers(0, 3000))))
        # the DAC reports whatever finished playing by now, every 16 ms
        played16 = min(len(audio16), max(0, first + MIC_CHUNK - played_at_mic))
        played_speaker = played16 * SPEAKER_RATE // MIC_RATE
        if played_speaker > reported:
            jitter = int(rng.integers(-report_jitter_us, report_jitter_us + 1))
            aligner.add_played(
                PlayedReport(played_speaker - reported, T0 + (played_at_mic + played16) * US // MIC_RATE + jitter)
            )
            reported = played_speaker
        blocks.extend(aligner.blocks())
    return np.concatenate([b.reference for b in blocks])


def test_reference_lands_at_dac_time():
    # a ramp, easy to locate
    audio = np.arange(1, 4001, dtype=np.int16)
    ref = reference(3200, audio)
    assert abs(int(np.argmax(ref != 0)) - 3200) <= MIC_RATE // 1000
    assert np.count_nonzero(ref) >= len(audio) - MIC_RATE // 1000


def test_report_jitter_does_not_tear_the_run():
    ref = reference(1600, np.arange(1, 8001, dtype=np.int16), report_jitter_us=2000)
    nz = np.flatnonzero(ref)
    # one continuous run: consecutive reference samples step by one
    assert np.mean(np.diff(ref[nz[0] : nz[-1] + 1].astype(np.int32)) == 1) > 0.99


def test_a_mic_block_waits_for_the_report_of_what_played_meanwhile():
    aligner = Aligner()
    aligner.add_sent(2400, np.ones(1600, dtype=np.int16))
    aligner.add_mic(mic_frame(0))
    assert list(aligner.blocks()) == []
