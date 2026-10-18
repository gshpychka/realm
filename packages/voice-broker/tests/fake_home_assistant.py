"""Home Assistant's websocket API as a HomeListener uses it, running Assist pipelines from speech to intent.

A model of home-assistant/core's assist_pipeline, as assist.py describes it:
- A run takes in its audio at 20 times real time, an assumed rate: a backlog sent at once is
  reported on a while after it arrives.
- A run's segmenter starts an utterance after 0.3 s of speech and ends it after 0.7 s of
  silence, or after 15 s of the run's audio whatever it holds.
- Speech recognition transcribes all of the run's audio up to that end: each word of which at
  least half is in it, and silence as Whisper can, "thank you".
- The conversation agent acts on whatever transcript it gets, so acting on echo, silence or part
  of a request shows as an action. It decides for `intent_s`, then makes one tool call.
- A cancelled run stops, all but a tool call under way, which finishes.
- A run ends with a timeout error after its `timeout` of wall time.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import numpy as np
from voice_broker.protocol import MIC_RATE
from websockets.exceptions import ConnectionClosedError

PIPELINE = "Voice broker home"
TOKEN = "token"
# How long a word takes to say.
WORD_S = 0.3
# What speech recognition makes of a run with no speech in it.
HALLUCINATION = "thank you"

# Samples at or above it are speech to the segmenter.
_SPEECH_LEVEL = 1000
# The segmenter's chunk.
_CHUNK = MIC_RATE // 100
_START_MS = 300
_END_MS = 700
_SEGMENT_MAX_MS = 15_000
_STT_S = 0.3
_TOOL_S = 0.2
_SPEED = 20
_PIPELINE_ID = "pipeline-id"

# Each word is a tone of its own, which speech recognition knows it by.
_tones: dict[str, int] = {}


def speech(text: str) -> np.ndarray:
    """`text` spoken."""
    words = [_tones.setdefault(word, _SPEECH_LEVEL + 10 * (len(_tones) + 1)) for word in text.split()]
    return np.repeat(np.array(words, dtype=np.int16), round(WORD_S * MIC_RATE))


def _transcript(audio: np.ndarray) -> str:
    words = {tone: word for word, tone in _tones.items()}
    # the bounds of each stretch of one sample value
    edges = np.flatnonzero(np.diff(audio, prepend=-1, append=-1))
    heard = [
        words[int(audio[start])]
        for start, end in zip(edges[:-1], edges[1:], strict=True)
        if audio[start] >= _SPEECH_LEVEL and end - start >= WORD_S * MIC_RATE / 2
    ]
    return " ".join(heard)


class FakeHomeAssistant:
    def __init__(self, intent_s: float = 1.0) -> None:
        # How long the conversation agent takes to act.
        self.intent_s = intent_s
        # Every transcript the agent acted on, in order.
        self.acted_on: list[str] = []
        # What can act out of order or cut an action short: two intent stages at once at a device, or a run
        # cancelled in its intent stage.
        self.violations: list[str] = []
        # Refuses connections.
        self.down = False
        self._sockets: list[_Socket] = []
        # Runs in their intent stage, by device.
        self._intents: dict[str, set[_Run]] = {}

    async def connect(self, url: str, **kwargs: Any) -> _Socket:
        if self.down:
            raise OSError("connection refused")
        socket = _Socket(self)
        self._sockets.append(socket)
        socket.push({"type": "auth_required"})
        return socket

    def drop_connections(self) -> None:
        for socket in self._sockets:
            socket.lose()

    def intent_starts(self, run: _Run) -> None:
        intents = self._intents.setdefault(run.device, set())
        if intents:
            self.violations.append(f"two intent stages at once at {run.device}")
        intents.add(run)

    def run_ends(self, run: _Run) -> None:
        self._intents.get(run.device, set()).discard(run)


class _Socket:
    def __init__(self, ha: FakeHomeAssistant) -> None:
        self._ha = ha
        self._inbox: asyncio.Queue[str | None] = asyncio.Queue()
        self._open = True
        self._runs: dict[int, _Run] = {}
        self._handlers: dict[int, _Run] = {}

    def push(self, message: dict[str, Any]) -> None:
        if self._open:
            self._inbox.put_nowait(json.dumps(message))

    def lose(self) -> None:
        if not self._open:
            return
        self._open = False
        self._inbox.put_nowait(None)
        for run in self._runs.values():
            run.disconnected()

    async def recv(self) -> str:
        if not self._open and self._inbox.empty():
            raise ConnectionClosedError(None, None)
        message = await self._inbox.get()
        if message is None:
            raise ConnectionClosedError(None, None)
        return message

    async def send(self, message: str | bytes) -> None:
        if not self._open:
            raise ConnectionClosedError(None, None)
        if isinstance(message, bytes):
            if (run := self._handlers.get(message[0])) is not None:
                run.hear(np.frombuffer(message[1:], dtype="<i2"))
            return
        command = json.loads(message)
        match command["type"]:
            case "auth":
                self.push({"type": "auth_ok" if command["access_token"] == TOKEN else "auth_invalid"})
            case "assist_pipeline/pipeline/list":
                self._result(command, {"pipelines": [{"id": _PIPELINE_ID, "name": PIPELINE}]})
            case "assist_pipeline/run":
                assert command["pipeline"] == _PIPELINE_ID and command["input"]["sample_rate"] == MIC_RATE
                handler = len(self._handlers) + 1
                run = _Run(self._ha, self, command["id"], command["device_id"], command["timeout"])
                self._runs[command["id"]] = run
                self._handlers[handler] = run
                self._result(command, None)
                run.event("run-start", {"runner_data": {"stt_binary_handler_id": handler}})
                run.event("stt-start")
            case "unsubscribe_events":
                if (run := self._runs.get(command["subscription"])) is not None:
                    run.unsubscribed()
                self._result(command, None)

    async def close(self) -> None:
        self.lose()

    def _result(self, command: dict[str, Any], result: Any) -> None:
        self.push({"id": command["id"], "type": "result", "success": True, "result": result})


class _Run:
    def __init__(self, ha: FakeHomeAssistant, socket: _Socket, run_id: int, device: str, timeout: float) -> None:
        self._ha = ha
        self._socket = socket
        self._id = run_id
        self.device = device
        self._pending = np.zeros(0, dtype=np.int16)
        self._audio: list[np.ndarray] = []
        self._ms = 0
        self._speech_ms = 0
        self._silence_ms = 0
        self._in_utterance = False
        self._listening = True
        self._intent_started = False
        # Its subscription is gone: no more events.
        self._silent = False
        self._ended = False
        self._stage: asyncio.Task[None] | None = None
        # Its tool call is under way.
        self._acting = False
        self._taking: asyncio.Task[None] | None = None
        self._deadline = asyncio.get_running_loop().call_later(timeout, self._timed_out)

    def event(self, kind: str, data: dict[str, Any] | None = None) -> None:
        if not self._silent:
            self._socket.push({"id": self._id, "type": "event", "event": {"type": kind, "data": data}})

    def hear(self, pcm: np.ndarray) -> None:
        if not self._listening:
            return
        self._pending = np.concatenate([self._pending, pcm])
        if self._taking is None or self._taking.done():
            self._taking = asyncio.ensure_future(self._take())

    async def _take(self) -> None:
        while self._listening and len(self._pending) >= _CHUNK:
            await asyncio.sleep(_CHUNK / MIC_RATE / _SPEED)
            chunk, self._pending = self._pending[:_CHUNK], self._pending[_CHUNK:]
            self._audio.append(chunk)
            self._ms += 10
            self._segment(bool(np.any(chunk >= _SPEECH_LEVEL)))

    def _segment(self, is_speech: bool) -> None:
        if self._ms >= _SEGMENT_MAX_MS:
            self._utterance_ends()
        elif not self._in_utterance:
            self._speech_ms = self._speech_ms + 10 if is_speech else 0
            if self._speech_ms >= _START_MS:
                self._in_utterance = True
                self.event("stt-vad-start", {"timestamp": self._ms})
        else:
            self._silence_ms = 0 if is_speech else self._silence_ms + 10
            if self._silence_ms >= _END_MS:
                self._utterance_ends()

    def _utterance_ends(self) -> None:
        self._listening = False
        self.event("stt-vad-end", {"timestamp": self._ms})
        self._stage = asyncio.ensure_future(self._understand())

    async def _understand(self) -> None:
        await asyncio.sleep(_STT_S)
        text = _transcript(np.concatenate(self._audio)) or HALLUCINATION
        self.event("stt-end", {"stt_output": {"text": text}})
        self._intent_started = True
        self._ha.intent_starts(self)
        self.event("intent-start", {"intent_input": text})
        await asyncio.sleep(self._ha.intent_s)
        self._acting = True
        self._ha.acted_on.append(text)
        self.event(
            "intent-progress", {"chat_log_delta": {"tool_calls": [{"tool_name": "HassTurnOn", "tool_args": {}}]}}
        )
        await asyncio.sleep(_TOOL_S)
        response = {"speech": {"plain": {"speech": "Done."}}, "response_type": "action_done", "data": {}}
        output = {"response": response, "conversation_id": "conversation", "continue_conversation": False}
        self.event("intent-end", {"processed_locally": False, "intent_output": output})
        self.event("run-end")
        self._end()

    def unsubscribed(self) -> None:
        if self._intent_started:
            self._ha.violations.append("a run cancelled after its intent stage began")
        self._cancel()

    def disconnected(self) -> None:
        self._cancel()

    def _timed_out(self) -> None:
        self.event("error", {"code": "timeout"})
        self.event("run-end")
        self._cancel()

    def _cancel(self) -> None:
        self._silent = True
        self._listening = False
        if self._taking is not None:
            self._taking.cancel()
        if self._acting:
            return
        if self._stage is not None:
            self._stage.cancel()
        self._end()

    def _end(self) -> None:
        if not self._ended:
            self._ended = True
            self._deadline.cancel()
            self._ha.run_ends(self)
