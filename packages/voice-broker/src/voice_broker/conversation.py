"""One conversation: a device WebSocket bridged to one OpenAI model session.

Audio path, device mic to OpenAI:
    MIC frames -> Aligner (pairs each 10 ms with what the speaker played)
    -> AEC3 -> the model session

Audio path, OpenAI to device speaker:
    model audio -> pending queue -> paced to the device so at most
    PLAYBACK_LEAD is buffered there.
"""

from __future__ import annotations

import asyncio
import enum
import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from typing import Protocol

import numpy as np
from websockets.exceptions import ConnectionClosed

from ._aec import EchoCanceller
from .alignment import AlignedBlock, Aligner
from .config import Config
from .dsp import speaker_to_mic_rate
from .protocol import (
    MIC_RATE,
    SPEAKER_RATE,
    ControlType,
    MicFrame,
    Phase,
    PlayedReport,
    ProtocolError,
    encode_audio,
    encode_control,
    parse_binary,
    parse_control,
)
from .recorder import NullRecorder, Recorder
from .session import MicOverflow, ModelSession, SessionRefused

log = logging.getLogger(__name__)

PLAYBACK_LEAD = SPEAKER_RATE * 300 // 1000
_SEND_CHUNK = SPEAKER_RATE * 40 // 1000
_PUMP_INTERVAL_S = 0.01
# No PLAYED report for this long while audio is in flight means the device lost
# its playback; stop waiting for it instead of hanging the conversation.
_PLAYED_STALL_S = 2.0
# Output peaks at or below this are silence: GPT-Live streams ±1 LSB between utterances.
_SILENCE_PEAK = 32
# Silence shorter than this inside a reply keeps the assistant audible.
_SOUND_HANGOVER = SPEAKER_RATE * 600 // 1000


class EndReason(enum.StrEnum):
    DEVICE_STOP = "device stop"
    DEVICE_GONE = "device disconnected"
    IDLE = "idle"
    MAX_DURATION = "max duration"
    OPENAI_GONE = "openai disconnected"
    MIC_OVERFLOW = "mic audio overflow"


class DeviceSocket(Protocol):
    """The subset of websockets' ServerConnection a conversation uses."""

    def __aiter__(self) -> AsyncIterator[str | bytes]: ...
    async def send(self, message: str | bytes) -> None: ...
    async def close(self) -> None: ...


class Conversation:
    def __init__(
        self, config: Config, name: str, device: DeviceSocket, session: ModelSession, aec: EchoCanceller
    ) -> None:
        self._config = config
        self._device = device
        self._session = session
        self._aligner = Aligner()
        # One per device, reused across its conversations: AEC3 suppresses
        # conservatively for its first seconds, and the room echo path it has
        # learned stays valid between conversations.
        self._aec = aec
        self._to_mic_rate = speaker_to_mic_rate()
        self._recorder: Recorder | NullRecorder = (
            Recorder(config.recordings_dir, name) if config.recordings_dir else NullRecorder()
        )

        self._pending: deque[np.ndarray] = deque()  # SPEAKER_RATE audio not yet sent
        self._pending_samples = 0
        self._sent_samples = 0  # SPEAKER_RATE samples sent this conversation
        # Stream position just past the last queued audio that carries sound.
        self._sound_end: int | None = None
        self._phase: Phase | None = None
        self._started = time.monotonic()
        self._first_mic = False
        self._first_sound_sample: int | None = None
        self._first_sound_played = False
        self._heard_activity = False
        self._mic_samples = 0
        self._raw_peak = 0
        self._clean_peak = 0
        self._last_activity = time.monotonic()
        self._last_played = time.monotonic()
        self._ended = asyncio.Event()
        self.end_reason: EndReason | None = None

    # -- lifecycle -----------------------------------------------------------

    async def run(self) -> EndReason:
        started = time.monotonic()
        self._started = started
        # The device streams from its first frame; the session holds what arrives before it is open.
        device = asyncio.create_task(self._device_loop(), name="device")
        running = asyncio.current_task()
        assert running is not None
        opened = False
        aborted = False
        # Set once run() is tearing down: an overflow then has nothing left to abandon.
        finishing = False

        def device_done(task: asyncio.Task[None]) -> None:
            nonlocal aborted
            if task.cancelled() or not isinstance(task.exception(), MicOverflow):
                return
            self._end(EndReason.MIC_OVERFLOW)
            if not opened and not finishing:
                # The session is still starting: abandon it rather than start one that can't hear the start.
                aborted = True
                running.cancel()

        device.add_done_callback(device_done)
        try:
            async with self._session.open(self):
                opened = True
                await self.set_phase(Phase.LISTENING)
                self._last_activity = time.monotonic()
                tasks = [
                    device,
                    asyncio.create_task(self._receive(), name="openai"),
                    asyncio.create_task(self._pump_loop(), name="pump"),
                    asyncio.create_task(self._watchdog(started), name="watchdog"),
                ]
                ended = asyncio.create_task(self._ended.wait())
                await asyncio.wait([*tasks, ended], return_when=asyncio.FIRST_COMPLETED)
                for task in tasks:
                    task.cancel()
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for task, result in zip(tasks, results, strict=True):
                    if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                        log.error("conversation task %s failed", task.get_name(), exc_info=result)
                ended.cancel()
        except SessionRefused as e:
            log.error("openai refused the session: %s", e)
        except asyncio.CancelledError:
            # Only the abandoned start is absorbed; a cancellation from outside still ends run().
            if not aborted or running.uncancel() > 0:
                raise
            log.error("conversation task device failed before the session opened", exc_info=device.exception())
        finally:
            finishing = True
            device.cancel()
            await asyncio.gather(device, return_exceptions=True)
            self._recorder.close()
            log.info(
                "mic: %.2f s processed, raw peak %d, clean peak %d",
                self._mic_samples / MIC_RATE,
                self._raw_peak,
                self._clean_peak,
            )
            try:
                await self._device.send(encode_control(ControlType.END))
                await self._device.close()
            except ConnectionClosed:
                pass
        return self.end_reason or EndReason.OPENAI_GONE

    def _end(self, reason: EndReason) -> None:
        if self.end_reason is None:
            self.end_reason = reason
            log.info("conversation ending: %s", reason)
        self._ended.set()

    async def _receive(self) -> None:
        await self._session.receive()
        self._end(EndReason.OPENAI_GONE)

    # -- Host ----------------------------------------------------------------

    @property
    def assistant_audible(self) -> bool:
        queued = self._pending_samples > 0 or self._aligner.in_flight_speaker_samples > 0
        if not queued or self._sound_end is None:
            return False
        return self._aligner.played_speaker_samples < self._sound_end + _SOUND_HANGOVER

    def play(self, samples: np.ndarray) -> None:
        if len(samples) and (samples.max() > _SILENCE_PEAK or samples.min() < -_SILENCE_PEAK):
            if self._first_sound_sample is None:
                first = int(np.flatnonzero((samples > _SILENCE_PEAK) | (samples < -_SILENCE_PEAK))[0])
                self._first_sound_sample = self._sent_samples + self._pending_samples + first
                log.info("startup: first audible model audio at %.1f ms", (time.monotonic() - self._started) * 1000)
            self._sound_end = self._sent_samples + self._pending_samples + len(samples)
        self._pending.append(samples)
        self._pending_samples += len(samples)

    async def set_phase(self, phase: Phase) -> None:
        if phase != self._phase:
            log.info("phase: %s", phase.value)
            self._phase = phase
            await self._device.send(encode_control(ControlType.PHASE, phase=phase.value))

    def mark_activity(self) -> None:
        self._heard_activity = True
        self._last_activity = time.monotonic()

    # -- device side ---------------------------------------------------------

    async def _device_loop(self) -> None:
        try:
            async for message in self._device:
                if isinstance(message, str):
                    kind, fields = parse_control(message)
                    log.info("device: %s %s", kind, fields)
                    if kind == ControlType.STOP:
                        self._end(EndReason.DEVICE_STOP)
                        return
                    log.warning("unexpected control from device: %s", kind)
                    continue
                try:
                    frame = parse_binary(message)
                except ProtocolError as e:
                    log.warning("dropping device frame: %s", e)
                    continue
                match frame:
                    case MicFrame():
                        if not self._first_mic:
                            self._first_mic = True
                            log.info("startup: first mic frame at %.1f ms", (time.monotonic() - self._started) * 1000)
                        self._aligner.add_mic(frame)
                        for block in self._aligner.blocks():
                            await self._process_block(block)
                    case PlayedReport():
                        self._aligner.add_played(frame)
                        self._last_played = time.monotonic()
                        if (
                            not self._first_sound_played
                            and self._first_sound_sample is not None
                            and self._aligner.played_speaker_samples > self._first_sound_sample
                        ):
                            self._first_sound_played = True
                            log.info("startup: first audible audio played at %.1f ms", (self._last_played - self._started) * 1000)
        except ConnectionClosed:
            pass
        self._end(EndReason.DEVICE_GONE)

    async def _process_block(self, block: AlignedBlock) -> None:
        self._aec.process_reverse(block.reference)
        cleaned = np.frombuffer(self._aec.process_capture(block.mic), dtype=np.int16)
        self._mic_samples += len(cleaned)
        self._raw_peak = max(self._raw_peak, int(block.mic.max()), -int(block.mic.min()))
        self._clean_peak = max(self._clean_peak, int(cleaned.max()), -int(cleaned.min()))
        self._recorder.block(block.mic, block.reference, cleaned)
        if self.assistant_audible:
            self.mark_activity()
        await self._session.on_mic(cleaned)

    # -- playback ------------------------------------------------------------

    async def _pump_loop(self) -> None:
        while True:
            await asyncio.sleep(_PUMP_INTERVAL_S)
            in_flight = self._aligner.in_flight_speaker_samples
            if in_flight and time.monotonic() - self._last_played > _PLAYED_STALL_S:
                log.warning("device stopped reporting playback with %d samples in flight", in_flight)
                self._aligner.abandon_in_flight()
                in_flight = 0
            while self._pending and in_flight < PLAYBACK_LEAD:
                chunk = self._take_pending(_SEND_CHUNK)
                self._aligner.add_sent(len(chunk), self._to_mic_rate(chunk))
                self._sent_samples += len(chunk)
                in_flight += len(chunk)
                if in_flight == len(chunk):
                    # Playback starting from idle: the stall clock starts now.
                    self._last_played = time.monotonic()
                await self._device.send(encode_audio(chunk.astype("<i2").tobytes()))
            if self.assistant_audible:
                await self.set_phase(Phase.REPLYING)
            elif self._phase == Phase.REPLYING:
                self._session.on_playback_finished()
                self.mark_activity()
                await self.set_phase(Phase.THINKING if self._session.busy else Phase.LISTENING)

    def _take_pending(self, n: int) -> np.ndarray:
        parts = []
        while self._pending and n > 0:
            head = self._pending[0]
            if len(head) <= n:
                parts.append(self._pending.popleft())
                n -= len(head)
            else:
                parts.append(head[:n])
                self._pending[0] = head[n:]
                n = 0
        chunk = np.concatenate(parts)
        self._pending_samples -= len(chunk)
        return chunk

    # -- limits --------------------------------------------------------------

    async def _watchdog(self, started: float) -> None:
        while True:
            await asyncio.sleep(0.5)
            now = time.monotonic()
            if now - started > self._config.max_conversation_s:
                self._end(EndReason.MAX_DURATION)
                return
            if self._session.hearing:
                # Speech the mic pacer still holds is activity the model hasn't reacted to yet: the idle
                # time starts once it has all reached the model, so a request said while Live was
                # starting is never ended unheard.
                self._last_activity = now
            busy = self.assistant_audible or self._session.busy
            idle_timeout = self._config.idle_timeout_s if self._heard_activity else self._config.initial_idle_timeout_s
            if not busy and now - self._last_activity > idle_timeout:
                self._end(EndReason.IDLE)
                return
