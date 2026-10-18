"""The echo canceller removes the speaker's echo and keeps the user's voice."""

import numpy as np
from voice_broker._aec import EchoCanceller
from voice_broker.protocol import MIC_RATE

BLOCK = MIC_RATE // 100


def speechlike(n: int, seed: int) -> np.ndarray:
    """Band-limited noise with a syllable-rate envelope, as int16."""
    rng = np.random.default_rng(seed)
    kernel = np.hanning(9)
    noise = np.convolve(rng.standard_normal(n), kernel / kernel.sum(), mode="same")
    signal = noise * (0.55 + 0.45 * np.sin(2 * np.pi * 4 * np.arange(n) / MIC_RATE))
    return (signal / np.max(np.abs(signal)) * 12000).astype(np.int16)


def dbfs(samples: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(samples.astype(np.float64)))))
    return 20 * np.log10(max(rms, 1e-3) / 32768.0)


def test_cancels_echo_and_keeps_near_end():
    n = 8 * MIC_RATE
    far = speechlike(n, seed=2)
    # the room: 40 ms of delay and a short decaying tail
    ir = np.zeros(40 * MIC_RATE // 1000 + 200)
    ir[40 * MIC_RATE // 1000] = 0.6
    ir[-200:] += np.random.default_rng(1).standard_normal(200) * 0.02 * np.exp(-np.arange(200) / 40)
    echo = np.convolve(far.astype(np.float64), ir)[:n]
    near = np.zeros(n)
    near_span = slice(6 * MIC_RATE, 7 * MIC_RATE)
    near[near_span] = speechlike(MIC_RATE, seed=3) * 0.5
    mic = np.clip(echo + near, -32768, 32767).astype(np.int16)

    aec = EchoCanceller(MIC_RATE)
    cleaned = []
    for i in range(0, n, BLOCK):
        aec.process_reverse(far[i : i + BLOCK])
        cleaned.append(np.frombuffer(aec.process_capture(mic[i : i + BLOCK]), dtype=np.int16))
    out = np.concatenate(cleaned)

    # converged (seconds 3-5, echo alone): the residual is far below the echo
    converged = slice(3 * MIC_RATE, 5 * MIC_RATE)
    assert dbfs(mic[converged]) - dbfs(out[converged]) > 20
    # double talk: the near end survives within a few dB
    assert abs(dbfs(out[near_span]) - dbfs(near[near_span].astype(np.int16))) < 6
