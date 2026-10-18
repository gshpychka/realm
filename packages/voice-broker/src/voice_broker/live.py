"""The full-duplex OpenAI Live backend.

GPT-Live listens while it speaks and decides for itself when to talk, yield or
keep going, so the echo-cancelled mic streams to it continuously and playback
only ever ends when it stops sending audio. Work it delegates goes to an agent
as a consult on the conversation's transcript, and GPT-Live speaks the answer.

How a delegation is answered is the conversation's mode (config.py), one of:
- consults only (no mode): every delegation is a consult;
- gated (Routed): a classifier picks Home Assistant's text conversation or a
  consult for each request, and only that one runs;
- parallel (Parallel), below.

With Home Assistant listening (Parallel), the same audio also reaches Home
Assistant's own Assist pipeline (assist.py), which alone acts on the home.
GPT-Live stays the only voice:
- A delegation goes to the agent, which has no home-action tools, for whatever
  is not home control. The Home Assistant turns heard by then are claimed by it,
  and both results go back as one answer.
- A Home Assistant turn no delegation claims reaches GPT-Live on its own.
- GPT-Live's transcript never reaches Home Assistant, and Home Assistant's never
  picks a backend. The two hear the same audio with different speech
  recognition, so their words are never compared. A delegation claims the
  Home Assistant turns heard but not yet told, in the order they happened.
  Their audio offsets are logged, not compared with GPT-Live's timeline, whose
  time base the API does not document.
- Whether the user spoke over the assistant is judged within GPT-Live's timeline
  alone, and goes to Home Assistant's listener (HomeEars.user_heard): a user
  transcript fragment against the assistant's own transcript, both stamped on it.
  No offset between it and the mic is assumed.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
from openai import AsyncOpenAI
from openai.resources.live.live import AsyncLiveConnection
from openai.types.live.initial_item_param import InitialItemParam
from openai.types.live.session_config_param import SessionConfigParam

from .assist import HeardSpeech, HomeEvent, HomeTurn, Outcome, Unavailable
from .config import Live
from .dsp import mic_to_speaker_rate
from .home_assistant import HomeAssistantFailed, HomeReply
from .openclaw import ConsultFailed, HistoryUnavailable, Role, Turn
from .protocol import SPEAKER_RATE, Phase
from .routing import RouteDecision, RouteRequest, RoutingFailed
from .session import Host, MicOverflow, SessionRefused, located, placement

log = logging.getLogger(__name__)

# Base64 audio, dozens per second; the recordings hold the same audio.
_AUDIO_EVENTS = frozenset({"session.output_audio.delta"})
# An append carries at most 500 tokens, and every token spans at least one byte.
_APPEND_MAX_BYTES = 500
# Live takes this many initial messages at most.
_INPUT_MAX_ITEMS = 128
# Mic audio not yet sent to Live, at most: held while the session starts (the device gives a startup
# 10 s), then while it catches up. More ends the conversation (MicOverflow): its start is never dropped.
_BACKLOG_MAX_SAMPLES = SPEAKER_RATE * 15
# Live hears held audio at most this much faster than real time, so a startup backlog
# reaches it as speech, not as one burst: 15 s held takes 75 s to catch up.
_CATCH_UP_SPEED = 1.2
# How far ahead of that pace the stream may run (s of wall time): the mic's jitter, never a burst. At any
# instant at most _CATCH_UP_SPEED x this plus one piece goes at once (0.4 s).
_PACE_AHEAD_S = 0.25
# The most audio in one append: a held stretch is paced in pieces.
_PIECE_SAMPLES = SPEAKER_RATE // 10
# Leads the initial messages, which are the agent's conversation before this one.
_HISTORY_LEAD = "Your text conversation with the user so far; the spoken conversation follows it."
# Ends the initial messages of a call: the backend is what the instructions call the agent.
_OPENING_LEAD = (
    "You opened this conversation for the backend, which has something to tell the user. Begin by telling them: "
    "{opening}\nDelegate the user's response to the backend, whatever it is."
)

_NO_TRANSCRIPT = "No transcript of the request arrived; ask the user to repeat it."
_HOME_UNCERTAIN = "Home Assistant gave no answer and may have acted anyway. Tell the user to check before asking again."

# Gated requests: what Live is told when nothing ran, and how a Home Assistant question reaches the user.
_NOT_ROUTED = "Nothing was done: the request could not be routed just now. Tell the user and ask them to try again."
_CLARIFY = "Nothing was done: it is unclear what to act on. Ask the user what they want done."
_STILL_SPEAKING = "Nothing was done yet: the user was still speaking. Let them finish, then delegate the whole request."
_ROUTED_HOME_ASKS = "Home Assistant asks: {question}\nAsk the user this, then delegate their answer, whatever it is."
# Waiting for the transcript to settle ends here; a longer stream is still speech in progress.
_SETTLE_MAX_S = 2.0
# Classifications of one request when more of it keeps arriving while it is classified.
_ROUTE_ATTEMPTS = 3

# Parallel: the assistant's transcript fragments this close on Live's timeline are one stretch of its speech.
_SPAN_JOIN_MS = 500
# Parallel: user speech starting this soon after the assistant's speech ended on Live's timeline is still over
# it: the speaker plays it out later than Live stamps it (conversation.py PLAYBACK_LEAD and its hangover).
_OVER_ASSISTANT_TAIL_MS = 1500
# Parallel: stretches of the assistant's speech kept to judge user speech against.
_SPANS_KEPT = 16
# Parallel: how long ago speech over the assistant began, at least, when its transcript arrives. A
# fragment's stamps don't include how late it arrives, which is not measured; this assumes up to 2.5 s,
# so the user's first words are kept. assist.BARGE_IN_BACK_MAX_S bounds it.
_BACK_MIN_MS = 2500
# Parallel: how long a finished Home Assistant turn waits for a delegation to claim it before it is told on its own:
# GPT-Live usually delegates before Home Assistant is done, so this only catches a late delegation.
_CLAIM_GRACE_S = 1.0
# After the agent answered a delegation, how much longer its Home Assistant turns may take before the
# agent's answer goes alone. Home Assistant's result then follows on its own, so GPT-Live is never held long.
_COMBINE_WAIT_S = 6.0
# The newest user turns an observation quotes.
_OBSERVED_TURNS = 3

# What GPT-Live is told about Home Assistant's turns.
_HOME_SAID = "Home Assistant: {speech}"
_HOME_SILENT = "Home Assistant: done."
_HOME_ASKS = "Home Assistant asks: {question}\nAsk the user this. Their answer reaches Home Assistant by itself; don't delegate it."
_HOME_FAILED = (
    "Home Assistant could not process what the user just said ({reason}), so it did nothing. If they asked for "
    "something in the home, tell them it did not happen."
)
_HOME_PENDING = "Home Assistant is still working on the home part; its result follows."
_HOME_UNAVAILABLE = (
    "Home Assistant is unavailable for this conversation ({reason}). Nothing in the home can be changed or "
    "checked now: if the user asks, tell them so, and never say it was done."
)
_OBSERVED = (
    "A check of the home after Home Assistant acted found: {discrepancy}\nTell the user, and ask whether to fix "
    "it. A fix they ask for reaches Home Assistant by itself; don't delegate it."
)

# Opens a Live connection; injected so tests can substitute OpenAI.
LiveConnector = Callable[[], AbstractAsyncContextManager[AsyncLiveConnection]]
# The agent's answer to a task; raises ConsultFailed.
Consult = Callable[[str], Awaitable[str]]
# The agent's recent conversation; raises HistoryUnavailable.
Recall = Callable[[], Awaitable[list[Turn]]]
# A read-only check of what Home Assistant did: None, or a discrepancy to tell. Raises ConsultFailed.
Observe = Callable[[str], Awaitable[str | None]]
# A classification logged and never acted on.
Shadow = Callable[[RouteRequest], Awaitable[RouteDecision]]


class HomeEars(Protocol):
    """Home Assistant listening to the conversation (assist.HomeListener)."""

    events: asyncio.Queue[HomeEvent]

    def feed(self, pcm: np.ndarray, audible: bool) -> None: ...
    def user_heard(self, back_s: float | None, during: bool = False) -> None: ...
    def start(self) -> None: ...
    def stop(self) -> asyncio.Task[None] | None: ...


@dataclass(frozen=True, slots=True)
class Routed:
    """Gated: delegated requests classified, then answered by Home Assistant or by the consult."""

    # Picks the backend; raises RoutingFailed.
    route: Callable[[RouteRequest], Awaitable[RouteDecision]]
    # Home Assistant's reply to text, continuing a conversation ID; raises HomeAssistantFailed.
    converse: Callable[[str, str | None], Awaitable[HomeReply]]
    # How long a question Home Assistant asked stays answerable.
    pending_question_s: float
    # Quiet after the last user transcript fragment before a request counts as complete.
    settle_s: float


@dataclass(frozen=True, slots=True)
class _Pending:
    """Gated: a question Home Assistant asked at this speaker and waits on."""

    conversation_id: str
    question: str
    # time.monotonic() past which it is dropped
    expires: float


@dataclass(frozen=True, slots=True)
class Parallel:
    """Home Assistant hearing the conversation beside GPT-Live, and owning the home."""

    home: HomeEars
    # Checks what Home Assistant did, off the critical path; None: no check.
    observe: Observe | None = None
    # A classifier's take on each delegation, for the log only; None: no request.
    shadow: Shadow | None = None


# How a conversation's delegations are answered; None: by consults only.
Mode = Routed | Parallel | None


@dataclass
class _Slot:
    """One Home Assistant turn on its way to GPT-Live."""

    turn: int
    result: asyncio.Future[HomeTurn]
    # A delegation answers with it.
    claimed: bool = False
    # GPT-Live is being told, or is never to be.
    delivered: bool = False
    # Set once GPT-Live has it: an observation of the turn comes after the turn itself.
    told: asyncio.Event = field(default_factory=asyncio.Event)
    # The mic stream's length when its result came: GPT-Live hears of it only after hearing that far.
    heard: int = 0


@dataclass
class _Claimed:
    """A delegation's Home Assistant turns: what to tell GPT-Live, and their outcomes for the log."""

    notes: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)
    # The turns this answer tells.
    slots: list[_Slot] = field(default_factory=list)


# Turns finishing after their conversation ended, kept until they end.
_FINISHING: set[asyncio.Task[None]] = set()


class _MicPacer:
    """The one way mic audio reaches Live: in order, at most `speed` times real time, and bounded.

    Pacing is a leaky bucket (GCRA): a piece goes once the stream is no more than `ahead_s` of wall time
    ahead of `speed` times real time. Idle time earns no credit beyond that lead, so a stall never turns
    into a burst: at any instant at most `speed * ahead_s` plus one piece goes. Audio the mic has sent
    counts until Live has taken it.
    """

    def __init__(
        self,
        rate: int,
        max_samples: int,
        speed: float = _CATCH_UP_SPEED,
        ahead_s: float = _PACE_AHEAD_S,
        piece_samples: int = _PIECE_SAMPLES,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._rate = rate
        self._max_samples = max_samples
        self._speed = speed
        self._ahead_s = ahead_s
        self._piece_samples = piece_samples
        self._clock = clock
        self._sleep = sleep
        self._queue: deque[np.ndarray] = deque()
        # Samples heard but not yet taken by Live, in flight included.
        self.pending_samples = 0
        self.sent_samples = 0
        # Every sample ever accepted: a mark in the stream (reached()).
        self.put_samples = 0
        self._wake = asyncio.Event()
        # Set on every piece Live takes, and when sending stops.
        self._progress = asyncio.Event()
        self._idle = asyncio.Event()
        self._idle.set()
        self._task: asyncio.Task[None] | None = None
        self._error: BaseException | None = None
        self._closed = False

    def put(self, samples: np.ndarray) -> None:
        """Queues `samples` for Live; never awaits. Raises MicOverflow, or the failure of an earlier send."""
        if self._closed:
            # The conversation has ended: there is no Live left to hear it.
            return
        if self._error is not None:
            raise self._error
        if self.pending_samples + len(samples) > self._max_samples:
            self._error = MicOverflow(
                f"{(self.pending_samples + len(samples)) / self._rate:.1f} s of mic audio waiting for Live, "
                f"more than {self._max_samples / self._rate:.0f} s"
            )
            raise self._error
        self._queue.append(samples)
        self.pending_samples += len(samples)
        self.put_samples += len(samples)
        self._idle.clear()
        self._wake.set()

    @property
    def behind(self) -> bool:
        """More than one piece waits for Live: it is still catching up on what the user said.

        Streaming in real time, at most about a piece is ever waiting, so this
        holds only while a backlog is paced out (or Live stalls, which the
        bound turns into MicOverflow).
        """
        return self.pending_samples > self._piece_samples

    def start(self, send: Callable[[np.ndarray], Awaitable[None]]) -> None:
        assert self._task is None and not self._closed
        self._task = asyncio.ensure_future(self._run(send))

    async def reached(self, mark: int) -> bool:
        """Waits until Live has taken the stream up to `mark` (a put_samples value); False: it never will."""
        while self.sent_samples < mark:
            if self._closed or self._error is not None:
                return False
            self._progress.clear()
            await self._progress.wait()
        return True

    async def drained(self) -> None:
        """Returns once Live has taken everything queued so far."""
        await self._idle.wait()

    async def close(self) -> None:
        """Stops sending; what is still queued goes nowhere, and is logged."""
        self._closed = True
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self.pending_samples:
            log.info("conversation ended with %.1f s of mic audio unsent", self.pending_samples / self._rate)
        self._queue.clear()
        self.pending_samples = 0
        self._idle.set()
        self._progress.set()

    async def _run(self, send: Callable[[np.ndarray], Awaitable[None]]) -> None:
        # Theoretical send time of the next piece, on `clock`.
        due = self._clock()
        try:
            while True:
                while not self._queue:
                    self._idle.set()
                    self._wake.clear()
                    await self._wake.wait()
                samples = self._queue.popleft()
                if len(samples) > self._piece_samples:
                    self._queue.appendleft(samples[self._piece_samples :])
                    samples = samples[: self._piece_samples]
                now = self._clock()
                due = max(due, now)
                if (wait := due - self._ahead_s - now) > 0:
                    await self._sleep(wait)
                await send(samples)
                # Charged from when Live took it: after a stalled send, that piece and a fresh lead
                # would otherwise land at one instant.
                due = max(due, self._clock()) + len(samples) / (self._rate * self._speed)
                self.pending_samples -= len(samples)
                self.sent_samples += len(samples)
                self._progress.set()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 -- any send failure is handed to the mic, which ends the conversation
            # The next put raises it, so the conversation ends on it rather than going deaf.
            log.error("sending mic audio to live failed: %s", e)
            self._error = e
            self._idle.set()
            self._progress.set()


def live_connector(client: AsyncOpenAI) -> LiveConnector:
    # A dropped primary WebSocket ends the conversation; the SDK's reconnect
    # would resume mid-sentence with no audio in between.
    return lambda: client.live.connect(max_retries=0)


class LiveSession:
    def __init__(
        self,
        config: Live,
        area: str,
        consult: Consult,
        recall: Recall,
        connect: LiveConnector,
        opening: str | None = None,
        mode: Mode = None,
    ) -> None:
        self._config = config
        self._area = area
        self._consult = consult
        # One mode at most, so Home Assistant never both takes a gated request and hears its audio.
        self._routed = mode if isinstance(mode, Routed) else None
        self._parallel = mode if isinstance(mode, Parallel) else None
        # Gated: this conversation's open Home Assistant question; it dies with the conversation.
        self._pending: _Pending | None = None
        # Gated: Live timeline start (ms) of each user transcript fragment heard, which the settling wait watches.
        self._user_starts: list[int] = []
        # Gated: Live timeline position (ms) of the newest delegation.
        self._delegation_offset: int | None = None
        # Parallel: Home Assistant's turns by number, until GPT-Live is told.
        self._slots: dict[int, _Slot] = {}
        # Parallel: the assistant's speech on Live's timeline, [start_ms, end_ms] of each stretch, newest last.
        self._assistant_spans: deque[list[int]] = deque(maxlen=_SPANS_KEPT)
        # Parallel: the newest end (ms) of a user transcript fragment on Live's timeline. Only the user's
        # are taken: they follow the mic audio, while the assistant's are stamped as its speech is made.
        self._timeline_ms = 0
        # Parallel: the gaps (HomeTurn.gap) a cut turn was told for: the other pieces of the same cut are not.
        self._gaps_told: set[int] = set()
        # The newest Home Assistant turn that acted: an observation of an older one is stale.
        self._latest_action: int | None = None
        self._observing: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        # The session is open for commentary.
        self._ready = asyncio.Event()
        self._recall = recall
        self._connect = connect
        # What the voice says first, in a conversation the agent opened.
        self._opening = opening
        self._to_openai_rate = mic_to_speaker_rate()
        self._conn: AsyncLiveConnection | None = None
        self._host: Host | None = None
        # Mic audio on its way to Live, at SPEAKER_RATE: held until the session is open, then paced.
        self._mic = _MicPacer(SPEAKER_RATE, _BACKLOG_MAX_SAMPLES)
        # Transcript fragments in delivery order.
        self._heard: list[Turn] = []
        self._logged = 0
        # Fragments before this index reached the agent in a consult it answered.
        self._consulted = 0
        self._consulting: asyncio.Task[None] | None = None
        # The newest delegation, which answers go to: a newer one supersedes the old on the model's side.
        self._delegation: str | None = None

    @asynccontextmanager
    async def open(self, host: Host) -> AsyncIterator[None]:
        self._host = host
        if self._parallel is not None:
            # First: Home Assistant connects while GPT-Live starts, and hears the mic from its first block.
            self._parallel.home.start()
            self._spawn(self._listen_home())
        try:
            try:
                history = await self._recall()
            except HistoryUnavailable as e:
                log.warning("starting without the recent conversation: %s", e)
                history = []
            async with self._connect() as conn:
                await conn.session.start(session=self._session_config(history))
                async for event in conn:
                    self._log_event(event)
                    if event.type == "session.started":
                        break
                    if event.type == "error":
                        raise SessionRefused(f"{event.error.message} ({event.error.code})")
                # What the mic sent so far goes first, paced, and every later block after it.
                self._mic.start(lambda samples: conn.session.input_audio.append(audio=_audio(samples)))
                self._conn = conn
                self._ready.set()
                try:
                    yield
                finally:
                    if self._consulting is not None:
                        self._consulting.cancel()
                    self._conn = None
                    await self._mic.close()
        finally:
            # Everything that can't be interrupted first: a cancellation at the await below skips nothing.
            for task in self._tasks:
                task.cancel()
            if self._parallel is not None and (finishing := self._parallel.home.stop()) is not None:
                _FINISHING.add(finishing)
                finishing.add_done_callback(_FINISHING.discard)
            await self._mic.close()

    @property
    def busy(self) -> bool:
        # A Home Assistant turn under way keeps the conversation open for its result.
        return self._consulting is not None or any(not slot.delivered for slot in self._slots.values())

    @property
    def hearing(self) -> bool:
        return self._mic.behind

    def on_playback_finished(self) -> None:
        self._flush_transcripts()

    def _session_config(self, history: list[Turn]) -> SessionConfigParam:
        config: SessionConfigParam = {
            "model": self._config.model,
            "instructions": located(self._config.instructions, self._area),
            "audio": {
                "format": {"type": "audio/pcm", "rate": SPEAKER_RATE},
                "output": {"voice": self._config.voice},
            },
            "delegation": {"type": "client"},
        }
        if items := _initial_items(history, self._opening):
            config["input"] = items
        return config

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        task.add_done_callback(_log_failure)
        return task

    # -- mic -----------------------------------------------------------------

    async def on_mic(self, samples: np.ndarray) -> None:
        if len(samples) == 0:
            return
        if self._parallel is not None:
            # Never awaits: Home Assistant's pace can't hold up GPT-Live.
            audible = self._host is not None and self._host.assistant_audible
            self._parallel.home.feed(samples, audible)
        upsampled = self._to_openai_rate(samples)
        if len(upsampled) == 0:
            return
        # Raises MicOverflow, which ends the conversation (conversation.py's device task).
        self._mic.put(upsampled)

    # -- OpenAI side ---------------------------------------------------------

    async def receive(self) -> None:
        assert self._conn is not None and self._host is not None
        async for event in self._conn:
            self._log_event(event)
            match event.type:
                case "session.output_audio.delta":
                    samples = np.frombuffer(base64.b64decode(event.delta), dtype="<i2").astype(np.int16)
                    self._host.play(samples)
                case "session.input_transcript.delta":
                    self._host.mark_activity()
                    self._user_starts.append(event.start_ms)
                    if self._parallel is not None:
                        self._timeline_ms = max(self._timeline_ms, event.end_ms)
                        back_s, during = self._over_assistant(event.start_ms)
                        if back_s is not None:
                            # Live's timeline trails the mic by what the pacer still holds; Home Assistant's doesn't.
                            back_s += self._mic.pending_samples / SPEAKER_RATE
                        self._parallel.home.user_heard(back_s, during)
                    self._hear("user", event.delta)
                case "session.output_transcript.delta":
                    if self._parallel is not None:
                        self._assistant_spoke(event.start_ms, event.end_ms)
                    self._hear("assistant", event.delta)
                case "session.delegation.created":
                    await self._host.set_phase(Phase.THINKING)
                    log.info("delegation %s at %d ms", event.delegation.id, event.offset_ms)
                    self._delegation_offset = event.offset_ms
                    self._delegate(event.delegation.id)
                case "session.closed":
                    log.info("live session closed: %s after %.1f s", event.reason, event.usage.seconds)
                    return
                case "error":
                    log.error("openai error: %s (%s)", event.error.message, event.error.code)
        self._flush_transcripts()

    def _assistant_spoke(self, start_ms: int, end_ms: int) -> None:
        spans = self._assistant_spans
        if spans and start_ms <= spans[-1][1] + _SPAN_JOIN_MS:
            spans[-1][1] = max(spans[-1][1], end_ms)
        else:
            spans.append([start_ms, end_ms])

    def _over_assistant(self, start_ms: int) -> tuple[float | None, bool]:
        """How long ago (s) user speech starting at `start_ms` began, if over the assistant's speech, else None;
        and whether it began within the assistant's speech itself rather than just after it.

        Both are on Live's own timeline, so no clock or audio offset is assumed: a fragment
        trailing what the user said before the assistant began starts before its speech.
        The time ago is measured to the newest end of the user's fragments, which trails the audio.
        This assumes each fragment is stamped with where its own words start (as every fragment's
        start_ms is documented), not where the utterance does.
        """
        if not any(start <= start_ms <= end + _OVER_ASSISTANT_TAIL_MS for start, end in self._assistant_spans):
            return None, False
        during = any(start <= start_ms <= end for start, end in self._assistant_spans)
        return max(self._timeline_ms - start_ms, _BACK_MIN_MS) / 1000, during

    def _hear(self, role: Role, text: str) -> None:
        if self._heard and self._heard[-1][0] != role:
            self._flush_transcripts()
        self._heard.append((role, text))

    # -- delegation ----------------------------------------------------------

    def _delegate(self, delegation_id: str) -> None:
        self._delegation = delegation_id
        # A running consult is a turn of the agent's own session, so it runs to its end.
        if self._consulting is None:
            self._consulting = asyncio.create_task(
                self._run_consults() if self._routed is None else self._run_routed(self._routed)
            )
        else:
            log.info("delegation %s waits for the running consult", delegation_id)

    async def _run_consults(self) -> None:
        """Consults until everything heard is answered at the newest delegation."""
        assert self._conn is not None and self._host is not None
        try:
            while True:
                delegation = self._delegation
                upto = len(self._heard)
                heard = self._heard[self._consulted : upto]
                # Home Assistant's turns heard by now are this delegation's to tell.
                slots = [s for s in self._slots.values() if not s.claimed and not s.delivered]
                for slot in slots:
                    slot.claimed = True
                self._shadow(heard)
                if any(role == "user" for role, _ in heard):
                    consult = asyncio.ensure_future(self._consult(self._task(heard)))
                    try:
                        if slots:
                            await asyncio.wait([consult], timeout=_COMBINE_WAIT_S)
                            if not consult.done():
                                # A slow consult (up to openclaw._TIMEOUT_S) holds no home result: Home
                                # Assistant has acted, and silence could get a command repeated. Each turn is
                                # told on its own once done, and the agent's answer follows.
                                log.info("consult still running; home assistant turns told on their own")
                                for slot in slots:
                                    slot.claimed = False
                                    if slot.result.done():
                                        self._spawn(self._tell_alone(slot))
                                slots = []
                        answer = await consult
                        self._consulted = upto
                    except ConsultFailed as e:
                        log.warning("consult failed: %s", e)
                        answer = f"The request failed: {e}"
                    finally:
                        consult.cancel()
                else:
                    answer = ""
                home = await self._claimed(slots)
                if self._parallel is not None:
                    log.info("delegation answered: home %s, agent %s", home.outcomes or "none", bool(answer))
                # Every delegation gets an answer, or GPT-Live waits on it.
                text = "\n".join(part for part in (*home.notes, answer) if part) or _NO_TRANSCRIPT
                for chunk in _chunks(text):
                    await self._conn.session.commentary.append(content=chunk, delegation_id=self._delegation)
                for slot in home.slots:
                    slot.told.set()
                # A delegation created meanwhile has its answer, unless more was said since.
                unheard = self._heard[self._consulted :]
                if self._delegation == delegation or not any(role == "user" for role, _ in unheard):
                    break
        finally:
            if self._consulting is asyncio.current_task():
                self._consulting = None
            # A consult that ended unexpectedly leaves no Home Assistant turn claimed and never told.
            for slot in self._slots.values():
                if slot.claimed and not slot.delivered:
                    slot.claimed = False
                    if slot.result.done() and self._conn is not None:
                        self._spawn(self._tell_alone(slot))
            self._host.mark_activity()
        if not self.busy and not self._host.assistant_audible:
            await self._host.set_phase(Phase.LISTENING)

    # -- gated delegation ----------------------------------------------------

    async def _run_routed(self, routed: Routed) -> None:
        """Like _run_consults, but each request goes to the one backend its classification picks."""
        assert self._conn is not None and self._host is not None
        try:
            while True:
                delegation = self._delegation
                answer = await self._answer_routed(routed)
                for chunk in _chunks(answer):
                    await self._conn.session.commentary.append(content=chunk, delegation_id=self._delegation)
                unheard = self._heard[self._consulted :]
                if self._delegation == delegation or not any(role == "user" for role, _ in unheard):
                    break
        finally:
            if self._consulting is asyncio.current_task():
                self._consulting = None
            self._host.mark_activity()
        if not self.busy and not self._host.assistant_audible:
            await self._host.set_phase(Phase.LISTENING)

    async def _settled(self, settle_s: float) -> bool:
        """Whether the user's transcript went quiet for `settle_s`, within _SETTLE_MAX_S.

        Live delegates with no end-of-utterance marker, and the transcript can trail it.
        """
        deadline = time.monotonic() + _SETTLE_MAX_S
        while True:
            seen = len(self._user_starts)
            await asyncio.sleep(settle_s)
            if len(self._user_starts) == seen:
                return True
            if time.monotonic() >= deadline:
                return False

    async def _answer_routed(self, routed: Routed) -> str:
        """The answer to what the user said since the last request, from the backend it is routed to."""
        for _ in range(_ROUTE_ATTEMPTS):
            if not await self._settled(routed.settle_s):
                # Left unconsumed: the next delegation takes the whole request.
                return _STILL_SPEAKING
            offset = self._delegation_offset
            upto = len(self._heard)
            heard = self._heard[self._consulted : upto]
            text = " ".join(t.strip() for role, t in _turns(heard) if role == "user").strip()
            if not text:
                return _NO_TRANSCRIPT
            # Everything said before the request, the voice asking a question included.
            first = next(i for i, (role, _) in enumerate(heard) if role == "user")
            context = tuple(_turns(self._heard[: self._consulted + first]))
            pending = self._pending
            if pending is not None and pending.expires <= time.monotonic():
                log.info("dropped an expired Home Assistant question")
                pending = self._pending = None
            fragments = len(self._user_starts)
            request = RouteRequest(text, context, self._area, pending.question if pending else None)
            try:
                decision = await routed.route(request)
            except Exception as e:  # noqa: BLE001 -- classifying acts on nothing, so any failure asks again
                # Class name only for a bug: its message could quote the request.
                log.warning("routing failed, nothing run: %s", e if isinstance(e, RoutingFailed) else type(e).__name__)
                self._pending = None
                self._consulted = upto
                return _NOT_ROUTED
            # The transcript trailed past the settling wait: speech from before the
            # delegation, so part of this request, arrived while it was classified.
            # Classify the whole of it instead of running a part.
            late = self._user_starts[fragments:]
            if offset is not None and any(start < offset for start in late):
                log.info("more of the request arrived while routing it; routing it again")
                continue
            # Taken whatever happens next: only a new question from Home Assistant opens another.
            self._pending = None
            # Consumed before anything runs: a backend that failed may still have
            # acted, so a later delegation must not run the request again.
            self._consulted = upto
            return await self._run_backend(routed, decision, text, heard, pending)
        return _STILL_SPEAKING

    async def _run_backend(
        self, routed: Routed, decision: RouteDecision, text: str, heard: list[Turn], pending: _Pending | None
    ) -> str:
        log.info(
            "route %s confidence=%s in %.0f ms%s",
            decision.route,
            decision.confidence,
            decision.elapsed_ms,
            " answering a Home Assistant question" if pending else "",
        )
        match decision.route:
            case "clarify":
                return _CLARIFY
            case "openclaw":
                try:
                    return await self._consult(self._task(heard))
                except ConsultFailed as e:
                    log.warning("consult failed: %s", e)
                    return f"The request failed: {e}"
            case "ha":
                try:
                    # A pending question continues even into an unrelated home request: the
                    # conversation agent sees the change of subject, and only its own context carries over.
                    reply = await routed.converse(text, pending.conversation_id if pending else None)
                except HomeAssistantFailed as e:
                    log.warning("home assistant failed: %s", e)
                    return _HOME_UNCERTAIN
                log.info("home assistant -> %s", reply.speech)
                if reply.continue_conversation and reply.conversation_id is not None:
                    self._pending = _Pending(
                        reply.conversation_id, reply.speech, time.monotonic() + routed.pending_question_s
                    )
                    return _ROUTED_HOME_ASKS.format(question=reply.speech)
                return reply.speech

    def _task(self, heard: list[Turn]) -> str:
        said = "\n".join(f"{role}: {text.strip()}" for role, text in _turns(heard))
        return (
            f"{placement(self._area)}\n"
            "The conversation at this speaker since your last answer to it, from speech"
            f" recognition, which can mishear:\n{said}\n"
        )

    # -- Home Assistant ------------------------------------------------------

    def _slot(self, turn: int) -> _Slot:
        if (slot := self._slots.get(turn)) is None:
            slot = self._slots[turn] = _Slot(turn, asyncio.get_running_loop().create_future())
        return slot

    async def _listen_home(self) -> None:
        assert self._parallel is not None
        while True:
            event = await self._parallel.home.events.get()
            try:
                await self._on_home(event)
            except Exception:  # one event's failure must not stop the turns after it
                log.exception("handling a home assistant event failed")

    async def _on_home(self, event: HomeEvent) -> None:
        match event:
            case HeardSpeech(turn=turn):
                self._slot(turn)
            case Unavailable(reason=reason):
                await self._ready.wait()
                assert self._conn is not None
                await self._conn.session.instructions.append(
                    content=_HOME_UNAVAILABLE.format(reason=reason), delegation_id=None
                )
            case HomeTurn() as result:
                slot = self._slot(result.turn)
                log.info(
                    "home assistant turn %d heard at samples %s-%s",
                    result.turn,
                    result.speech_start,
                    result.speech_end,
                )
                if not slot.result.done():
                    slot.result.set_result(result)
                    slot.heard = self._mic.put_samples
                if result.outcome == Outcome.ACTED:
                    self._latest_action = result.turn
                    self._observe(result)
                if not slot.claimed:
                    self._spawn(self._tell_alone(slot))

    async def _tell_alone(self, slot: _Slot) -> None:
        """Tells GPT-Live a Home Assistant turn no delegation claims."""
        await asyncio.sleep(_CLAIM_GRACE_S)
        if slot.claimed or slot.delivered:
            return
        slot.delivered = True
        try:
            result = slot.result.result()
            note = _home_note(result)
            if note is None:
                return
            if not self._first_of_gap(result):
                return
            await self._ready.wait()
            # Not before GPT-Live has heard the request: at startup the mic reaches it paced, behind Home Assistant.
            if not await self._mic.reached(slot.heard) or self._conn is None:
                return
            assert self._host is not None
            text, speakable = note
            append = self._conn.session.commentary.append if speakable else self._conn.session.thinking.append
            for chunk in _chunks(text):
                await append(content=chunk, delegation_id=None)
            self._host.mark_activity()
        finally:
            slot.told.set()
            # Playback that ended while this turn was pending left the speaker thinking; a silent result
            # starts no playback to end that.
            if self._host is not None and not self.busy and not self._host.assistant_audible:
                await self._host.set_phase(Phase.LISTENING)

    async def _claimed(self, slots: list[_Slot]) -> _Claimed:
        """What the claimed turns did, waiting a while for any still under way."""
        claimed = _Claimed()
        if not slots:
            return claimed
        await asyncio.wait([slot.result for slot in slots], timeout=_COMBINE_WAIT_S)
        pending = False
        for slot in slots:
            if not slot.result.done():
                # Released: _listen_home tells GPT-Live on its own once it is done.
                slot.claimed = False
                pending = True
                continue
            if self._mic.behind and self._mic.sent_samples < slot.heard:
                # GPT-Live hasn't heard this request yet: at startup the mic reaches it paced, behind Home
                # Assistant. Released, and told on its own once GPT-Live has heard it (_tell_alone). Streaming
                # in real time, at most the piece in flight is unsent (`slot.heard` is the stream at the
                # result, past the request's end), so the result goes with this answer.
                slot.claimed = False
                self._spawn(self._tell_alone(slot))
                continue
            slot.delivered = True
            claimed.slots.append(slot)
            result = slot.result.result()
            claimed.outcomes.append(str(result.outcome))
            if (note := _home_note(result)) is not None and self._first_of_gap(result):
                claimed.notes.append(note[0])
        if pending:
            claimed.notes.append(_HOME_PENDING)
        return claimed

    def _first_of_gap(self, result: HomeTurn) -> bool:
        """Whether to tell `result`: the pieces of one cut utterance each report it, and it is told once."""
        if result.gap is None:
            return True
        if result.gap in self._gaps_told:
            return False
        self._gaps_told.add(result.gap)
        return True

    def _observe(self, result: HomeTurn) -> None:
        """Checks, off the critical path, that what Home Assistant did matches the request."""
        assert self._parallel is not None
        if self._parallel.observe is None:
            return
        if self._observing is not None:
            # A newer action supersedes the check of an older one.
            self._observing.cancel()
        self._observing = self._spawn(self._check(self._parallel.observe, result))

    async def _check(self, observe: Observe, result: HomeTurn) -> None:
        told = self._slot(result.turn).told
        try:
            discrepancy = await observe(self._evidence(result))
        except ConsultFailed as e:
            log.warning("observation of home assistant turn %d failed: %s", result.turn, e)
            return
        if discrepancy is None:
            log.info("observation of home assistant turn %d: matches", result.turn)
            return
        if self._latest_action != result.turn:
            log.info("observation of home assistant turn %d dropped: a newer action followed", result.turn)
            return
        # After Home Assistant's own result, never before it.
        await told.wait()
        if self._conn is None or self._latest_action != result.turn:
            return
        for chunk in _chunks(_OBSERVED.format(discrepancy=discrepancy)):
            await self._conn.session.commentary.append(content=chunk, delegation_id=None)

    def _evidence(self, result: HomeTurn) -> str:
        said = [text.strip() for role, text in _turns(self._heard) if role == "user"][-_OBSERVED_TURNS:]
        tools = [{"tool": t.name, "args": t.args, "failed": t.failed} for t in result.tools if not t.external]
        return (
            f"{placement(self._area)}\n"
            "The user's latest words, from GPT-Live's speech recognition, which can mishear:\n"
            + "\n".join(f"- {s}" for s in said)
            + f"\nWhat Home Assistant heard: {result.heard!r}\n"
            f"Home Assistant's tool calls: {json.dumps(tools, ensure_ascii=False, default=str)}\n"
            f"Home Assistant replied: {result.speech!r}\n"
        )

    def _shadow(self, heard: list[Turn]) -> None:
        if self._parallel is None or (shadow := self._parallel.shadow) is None:
            return
        text = " ".join(t.strip() for role, t in _turns(heard) if role == "user").strip()
        if not text:
            return
        context = tuple(_turns(self._heard[: self._consulted]))
        self._spawn(_log_shadow(shadow, RouteRequest(text, context, self._area)))

    # -- logging -------------------------------------------------------------

    def _log_event(self, event: Any) -> None:
        if event.type not in _AUDIO_EVENTS:
            log.info("openai: %r", event)

    def _flush_transcripts(self) -> None:
        """Transcripts arrive as fragments with no end marker; log each side's run as a line."""
        for role, text in _turns(self._heard[self._logged :]):
            log.info("%s: %s", role, text.strip())
        self._logged = len(self._heard)


def _log_failure(task: asyncio.Task[Any]) -> None:
    """Logs a background task's exception, which nothing else awaits."""
    if not task.cancelled() and (e := task.exception()) is not None:
        log.error("background task failed", exc_info=e)


async def _log_shadow(shadow: Shadow, request: RouteRequest) -> None:
    try:
        decision = await shadow(request)
    except Exception as e:  # noqa: BLE001 -- the shadow decides nothing; class name only, a message can quote speech
        log.info("shadow classification failed: %s", type(e).__name__)
        return
    log.info(
        "shadow classification: %s confidence=%s in %.0f ms", decision.route, decision.confidence, decision.elapsed_ms
    )


def _home_note(result: HomeTurn) -> tuple[str, bool] | None:
    """What GPT-Live is told of a Home Assistant turn, and whether it is to be spoken; None: nothing."""
    match result.outcome:
        case Outcome.ACTED | Outcome.ANSWERED if result.asks:
            # It did something and asks a follow-up: the question carries its speech.
            return _HOME_ASKS.format(question=result.speech), True
        case Outcome.ACTED | Outcome.ANSWERED:
            return (_HOME_SAID.format(speech=result.speech) if result.speech else _HOME_SILENT), True
        case Outcome.ASKED:
            return _HOME_ASKS.format(question=result.speech), True
        case Outcome.UNCERTAIN:
            return _HOME_UNCERTAIN, True
        case Outcome.FAILED:
            # Silent context: it may have been no home request at all.
            return _HOME_FAILED.format(reason=result.reason), False
        case Outcome.ABSTAINED:
            return None


def _initial_items(history: list[Turn], opening: str | None) -> list[InitialItemParam]:
    """Live's initial messages: the newest of `history`, led by what it is, then the opening of a call."""
    items: list[InitialItemParam] = []
    if history:
        items.append(_developer(_HISTORY_LEAD))
        room = _INPUT_MAX_ITEMS - 1 - (1 if opening else 0)
        for role, text in history[-room:]:
            if role == "user":
                items.append({"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]})
            else:
                items.append(
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}
                )
    if opening:
        items.append(_developer(_OPENING_LEAD.format(opening=opening)))
    return items


def _developer(text: str) -> InitialItemParam:
    return {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": text}]}


def _audio(samples: np.ndarray) -> str:
    """SPEAKER_RATE samples as Live's base64 PCM."""
    return base64.b64encode(samples.tobytes()).decode()


def _turns(fragments: list[Turn]) -> list[Turn]:
    """Consecutive fragments from one side, joined."""
    turns: list[Turn] = []
    for role, text in fragments:
        if turns and turns[-1][0] == role:
            turns[-1] = (role, turns[-1][1] + text)
        else:
            turns.append((role, text))
    return turns


def _chunks(text: str) -> list[str]:
    """`text` split between words into appends of at most _APPEND_MAX_BYTES."""
    chunks: list[str] = []
    for word in text.split():
        if chunks and len(f"{chunks[-1]} {word}".encode()) <= _APPEND_MAX_BYTES:
            chunks[-1] = f"{chunks[-1]} {word}"
        else:
            chunks.append(word.encode()[:_APPEND_MAX_BYTES].decode(errors="ignore"))
    return chunks
