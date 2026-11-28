"""Wire protocol between the Voice PE firmware and the broker.

One WebSocket per conversation, opened by the device on wake word and closed
by either side when the conversation ends. The device authenticates with an
`Authorization: Bearer <token>` header on the upgrade request.

Binary frames start with a one-byte kind; all integers are little-endian.

device -> broker
  MIC     kind, u32 first_sample, i64 capture_us, PCM16 mono @ MIC_RATE
          Streams after admission and the local wake cue, so speech reaches
          the broker while the model starts up. first_sample counts mic
          samples since streaming began; a gap means the device dropped
          audio. capture_us is esp_timer time of the first sample.
  PLAYED  kind, u32 frames, i64 dac_us
          `frames` more samples of the SPEAKER_RATE stream finished leaving the
          DAC at esp_timer time dac_us (ESPHome's audio_output_callback).

broker -> device
  AUDIO   kind, PCM16 mono @ SPEAKER_RATE

Text frames are JSON objects with a "type" field, see ControlType.

The C++ side mirrors these constants in
scripts/voice-pe/components/voice_broker/protocol.h; keep them in sync.
"""

from __future__ import annotations

import enum
import json
import struct
from dataclasses import dataclass

MIC_RATE = 16000
SPEAKER_RATE = 24000  # OpenAI Live's highest PCM rate
SAMPLE_BYTES = 2

_MIC_HEADER = struct.Struct("<BIq")
_PLAYED = struct.Struct("<BIq")


class Kind(enum.IntEnum):
    MIC = 0x01
    PLAYED = 0x02
    AUDIO = 0x81


class ControlType(enum.StrEnum):
    # device -> broker
    START = "start"  # {"wake_word": str}; always the first frame
    STOP = "stop"  # user ended the conversation (button or wake word)
    # broker -> device
    ADMITTED = "admitted"  # this device owns the wake
    SUPPRESSED = "suppressed"  # another device owns the wake; end silently
    PHASE = "phase"  # {"phase": Phase}
    END = "end"  # conversation over; device closes the socket


class Phase(enum.StrEnum):
    LISTENING = "listening"
    THINKING = "thinking"
    REPLYING = "replying"


@dataclass(frozen=True, slots=True)
class Start:
    wake_word: str


@dataclass(frozen=True, slots=True)
class MicFrame:
    first_sample: int
    capture_us: int
    pcm: bytes


@dataclass(frozen=True, slots=True)
class PlayedReport:
    frames: int
    dac_us: int


class ProtocolError(ValueError):
    pass


def parse_binary(data: bytes) -> MicFrame | PlayedReport:
    if not data:
        raise ProtocolError("empty binary frame")
    kind = data[0]
    if kind == Kind.MIC:
        if len(data) < _MIC_HEADER.size:
            raise ProtocolError("short MIC frame")
        _, first_sample, capture_us = _MIC_HEADER.unpack_from(data)
        pcm = data[_MIC_HEADER.size :]
        if len(pcm) % SAMPLE_BYTES:
            raise ProtocolError("MIC payload is not whole samples")
        return MicFrame(first_sample, capture_us, pcm)
    if kind == Kind.PLAYED:
        if len(data) != _PLAYED.size:
            raise ProtocolError("bad PLAYED frame length")
        _, frames, dac_us = _PLAYED.unpack(data)
        return PlayedReport(frames, dac_us)
    raise ProtocolError(f"unknown binary kind 0x{kind:02x}")


def encode_audio(pcm: bytes) -> bytes:
    return bytes([Kind.AUDIO]) + pcm


def encode_control(kind: ControlType, **fields: str) -> str:
    return json.dumps({"type": kind.value, **fields})


def parse_control(text: str) -> tuple[ControlType, dict[str, object]]:
    try:
        msg = json.loads(text)
        return ControlType(msg["type"]), msg
    except (ValueError, KeyError, TypeError) as e:
        raise ProtocolError(f"bad control frame: {text[:80]!r}") from e


def parse_start(message: str | bytes) -> Start:
    if not isinstance(message, str):
        raise ProtocolError(f"expected {ControlType.START}, got a binary frame")
    kind, fields = parse_control(message)
    if kind != ControlType.START:
        raise ProtocolError(f"expected {ControlType.START}, got {kind}")
    return Start(str(fields.get("wake_word", "")))


def encode_mic(first_sample: int, capture_us: int, pcm: bytes) -> bytes:
    """Device-side encoding, used by tests and the simulator."""
    return _MIC_HEADER.pack(Kind.MIC, first_sample, capture_us) + pcm


def encode_played(frames: int, dac_us: int) -> bytes:
    """Device-side encoding, used by tests and the simulator."""
    return _PLAYED.pack(Kind.PLAYED, frames, dac_us)
