"""Broker configuration, read from one JSON file.

Secrets are never inline: the file names paths (systemd credentials in
production) and they are read at startup.

What happens to a delegated request is one of three modes, by which of
`routing` and `home_assistant` is set (never both):
- neither: every delegated request is an OpenClaw consult;
- `routing` (gated): a classifier picks Home Assistant's text conversation or
  OpenClaw for each request, and only that one runs (routing.py);
- `home_assistant` (parallel): Home Assistant hears the conversation's audio
  itself and alone acts on the home (assist.py). No classifier gates anything;
  one may shadow, for the log only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _read_secret(path: str) -> str:
    return Path(path).read_text().strip()


# The shortest classification timeout accepted. A spoken request usually opens a new connection,
# because requests are usually further apart than httpx2's 5 s keep-alive. DNS, TCP and TLS take
# 0.3-0.6 s of the limit from hoard. Cold Decisions answers took 0.78-1.12 s, and on
# 2026-10-16 22:24 a request got no answer within 1.5 s and had to be asked again.
MIN_ROUTING_TIMEOUT_S = 3.0
# The longest accepted: a diagnostic allowance for telling a slow Decisions answer from none,
# set on hoard after two requests on 2026-10-16 23:01 ran out of 4 s. The user waits this
# long, while Live keeps talking, before being asked to try again. A shadow classification
# decides nothing, so for it the limit only bounds a background request.
MAX_ROUTING_TIMEOUT_S = 30.0

# Leads the identity file's text: the assistant's description of itself.
_IDENTITY_LEAD = "Who you are, in your own words; the backend is your own memory and tools:"


@dataclass(frozen=True, slots=True)
class Live:
    """The full-duplex OpenAI Live backend."""

    model: str
    voice: str
    # How the voice converses and when it delegates, led by who it is when
    # the identity file says so.
    instructions: str


@dataclass(frozen=True, slots=True)
class History:
    """How much of the agent's conversation the voice starts with."""

    # Newest transcript messages read, tool calls and results among them, at most.
    max_messages: int
    # Messages older than this are left out.
    max_age_s: float
    # Text of the messages kept, newest first, at most.
    max_chars: int


@dataclass(frozen=True, slots=True)
class Overflow:
    """A spoken conversation's own session, for when the agent's session is too full for it (openclaw.py)."""

    # The overflow session's key is this, then the conversation's id: the same agent, a new session.
    session_prefix: str
    # Text of the agent session's newest messages the overflow session starts with, at most.
    handoff_max_chars: int
    # Whether a consult counts as fitting the agent session when its context use can't be read
    # (OVERFLOW_WHEN_UNKNOWN): an explicit choice, never a guess.
    fits_when_unknown: bool
    # Tokens the gateway's own check counts on top of what the broker can read: chiefly the agent's
    # rendered system prompt, estimated again before each prompt (openclaw.py preflight).
    margin_tokens: int


# overflow.when_unknown in the JSON: the session a conversation goes to when the agent session's use is unknown.
OVERFLOW_WHEN_UNKNOWN = ("main", "overflow")


@dataclass(frozen=True, slots=True)
class OpenClaw:
    """The OpenClaw gateway that carries out delegated work."""

    # Base URL of the gateway's HTTP endpoints.
    url: str
    # The gateway's shared secret.
    token: str
    # The agent session consults are turns of. Its `agent:<id>:` prefix picks the agent and
    # with it the agent's tools: the gateway ignores any other agent selection on this path.
    session_key: str
    # Added to the agent's own prompt for every consult.
    instructions: str
    # Backend model for consults; None keeps the agent's own.
    model: str | None
    history: History
    # The session whose transcript the voice starts with; session_key's when None.
    history_session_key: str | None = None
    # The session observations are turns of; None: no observer.
    observer_session_key: str | None = None
    # The agent consults and observations run as, named on every request; None: the gateway's default.
    # With more than one agent the gateway has no default for this endpoint: an unnamed
    # request fails (src/gateway/http-utils.ts resolveDefaultAgentId under explicit ownership).
    agent: str | None = None
    # None: every consult is a turn of session_key, however full it is.
    overflow: Overflow | None = None


@dataclass(frozen=True, slots=True)
class Device:
    """A Voice PE allowed to open conversations."""

    name: str
    # The address it connects from.
    address: str
    # The room it stands in.
    area: str
    # The Home Assistant action that makes it open a conversation.
    call_action: str
    # Its ESPHome device in Home Assistant's device registry, which its home
    # requests or speech are run as; None while Home Assistant takes neither.
    home_assistant_device_id: str | None = None


@dataclass(frozen=True, slots=True)
class DecisionsProvider:
    """OpenAI Decisions, on the broker's OpenAI key."""

    model: str


@dataclass(frozen=True, slots=True)
class JevProvider:
    """TypeSafe Jev through OpenRouter System One, on an OpenRouter key."""

    model: str
    # Kept out of repr, so logging the config can't print it.
    api_key: str = field(repr=False)


# A classifier of delegated requests (routing.router builds it).
Provider = DecisionsProvider | JevProvider
# Provider names in the JSON; without one, Decisions, as before the choice existed.
PROVIDERS = ("decisions", "jev")


@dataclass(frozen=True, slots=True)
class Routing:
    """Gated mode: delegated requests split between Home Assistant and OpenClaw by a classifier (routing.py)."""

    provider: Provider
    # Past this, the request is not classified and nothing runs.
    timeout_s: float
    # The Assist pipeline whose conversation agent home requests go to.
    pipeline: str
    # How long a question Home Assistant asked stays answerable. Home
    # Assistant forgets the conversation after 5 minutes idle
    # (helpers/chat_session.py CONVERSATION_TIMEOUT), so it must be shorter.
    pending_question_s: float
    # Quiet after the last transcript fragment before a request counts as
    # complete: Live delegates without marking the end of the utterance.
    settle_s: float


@dataclass(frozen=True, slots=True)
class RoutingShadow:
    """A classification of each delegation, logged beside the real outcome and never acted on."""

    provider: Provider
    # Bounds the background request only.
    timeout_s: float


@dataclass(frozen=True, slots=True)
class HomeAssistantAudio:
    """Parallel mode: Home Assistant hearing every utterance and owning the home (assist.py)."""

    # Name of the Assist pipeline the audio runs on: speech recognition and a home-only agent.
    pipeline: str
    # Names, after the last "__", of the agent's tools that only read the home.
    read_only_tools: frozenset[str]
    # Names of exposed tools that do non-home work: their use is no evidence of home work.
    non_home_tools: frozenset[str]
    # The user's speech over the assistant reaches Home Assistant once GPT-Live reports it; otherwise
    # all audio while the assistant is audible is dropped as echo.
    barge_in: bool
    # None: no shadow classification, and no classifier request.
    shadow: RoutingShadow | None = None


@dataclass(frozen=True, slots=True)
class Calls:
    """How the agent opens conversations on the speakers."""

    # Unix socket its requests arrive on.
    socket: Path
    # Home Assistant, whose device actions ring the speakers.
    home_assistant_url: str
    home_assistant_token: str


@dataclass(frozen=True, slots=True)
class Config:
    listen_host: str
    listen_port: int
    device_token: str
    openai_api_key: str
    devices: list[Device]
    live: Live
    openclaw: OpenClaw
    calls: Calls
    # Conversation ends after this long with nobody speaking and nothing playing.
    idle_timeout_s: float
    # Hard cap on one conversation, against sessions stuck open and billing.
    max_conversation_s: float
    # When set, every conversation's mic, reference and echo-cancelled audio
    # is written here for tuning.
    recordings_dir: Path | None
    # Gated mode; None: no classifier picks a backend.
    routing: Routing | None = None
    # Parallel mode; None: Home Assistant does not hear the audio.
    home_assistant: HomeAssistantAudio | None = None


def _live(raw: dict[str, Any]) -> Live:
    instructions = raw["instructions"]
    identity_file = raw.get("identity_file")
    identity = Path(identity_file).read_text().strip() if identity_file else ""
    if identity:
        instructions = f"{_IDENTITY_LEAD}\n{identity}\n\n{instructions}"
    return Live(model=raw["model"], voice=raw["voice"], instructions=instructions)


def _history(raw: dict[str, Any]) -> History:
    return History(
        max_messages=int(raw["max_messages"]),
        max_age_s=float(raw["max_age_s"]),
        max_chars=int(raw["max_chars"]),
    )


def _overflow(raw: dict[str, Any], session_key: str) -> Overflow:
    when_unknown = raw["when_unknown"]
    if when_unknown not in OVERFLOW_WHEN_UNKNOWN:
        raise ValueError(f"openclaw.overflow.when_unknown must be one of {', '.join(OVERFLOW_WHEN_UNKNOWN)}")
    overflow = Overflow(
        session_prefix=raw["session_prefix"],
        handoff_max_chars=int(raw["handoff_max_chars"]),
        fits_when_unknown=when_unknown == "main",
        margin_tokens=int(raw["margin_tokens"]),
    )
    # The agent is the session key's `agent:<id>:` prefix: an overflow session of another agent
    # would run with that agent's tools.
    agent_prefix = ":".join(session_key.split(":")[:2]) + ":"
    if not session_key.startswith("agent:") or not overflow.session_prefix.startswith(agent_prefix):
        raise ValueError(f"openclaw.overflow sessions must be {session_key!r}'s agent's")
    name = overflow.session_prefix.removeprefix(agent_prefix).removesuffix(":")
    if not overflow.session_prefix.endswith(":") or not name or ":" in name:
        raise ValueError("openclaw.overflow.session_prefix must be agent:<id>:<name>:")
    # Overflow sessions are their own, never the agent session or one under it.
    if overflow.session_prefix.startswith(f"{session_key}:"):
        raise ValueError(f"openclaw.overflow.session_prefix must not be under {session_key!r}")
    if overflow.handoff_max_chars < 0 or overflow.margin_tokens < 0:
        raise ValueError("openclaw.overflow.handoff_max_chars and margin_tokens must be at least 0")
    return overflow


def _openclaw(raw: dict[str, Any]) -> OpenClaw:
    openclaw = OpenClaw(
        url=raw["url"],
        token=_read_secret(raw["token_file"]),
        session_key=raw["session_key"],
        instructions=raw["instructions"],
        model=raw.get("model"),
        history=_history(raw["history"]),
        history_session_key=raw.get("history_session_key") or None,
        observer_session_key=raw.get("observer_session_key") or None,
        agent=raw.get("agent") or None,
        overflow=_overflow(raw["overflow"], raw["session_key"]) if raw.get("overflow") else None,
    )
    if openclaw.agent is not None:
        # The gateway runs the session key's agent whatever agent is named (gateway/openai-compatible-agent-run.ts),
        # so a mismatch would run, with its tools, another agent than the one named: refused here.
        prefix = f"agent:{openclaw.agent}:"
        for key in (openclaw.session_key, openclaw.observer_session_key):
            if key is not None and not key.startswith(prefix):
                raise ValueError(f"openclaw session {key!r} is not agent {openclaw.agent!r}'s")
    return openclaw


def _calls(raw: dict[str, Any]) -> Calls:
    return Calls(
        socket=Path(raw["socket"]),
        home_assistant_url=raw["home_assistant_url"],
        home_assistant_token=_read_secret(raw["home_assistant_token_file"]),
    )


def _provider(raw: dict[str, Any], where: str) -> Provider:
    """The classifier configured at `where` ("routing", or the shadow's), for messages."""
    name = raw.get("provider", "decisions")
    model = raw["model"]
    if not isinstance(model, str) or not model:
        raise ValueError(f"{where} needs a model")
    key_file = raw.get("api_key_file")
    match name:
        case "decisions":
            if key_file is not None:
                raise ValueError(f"{where}.api_key_file is for jev: Decisions runs on the broker's OpenAI key")
            return DecisionsProvider(model)
        case "jev":
            if not key_file:
                raise ValueError(f"{where}.provider jev needs api_key_file, an OpenRouter key")
            api_key = _read_secret(key_file)
            if not api_key:
                raise ValueError(f"{where}.api_key_file is empty")
            return JevProvider(model, api_key)
        case _:
            raise ValueError(f"{where}.provider must be one of {', '.join(PROVIDERS)}")


def _timeout(raw: dict[str, Any], where: str) -> float:
    timeout_s = float(raw["timeout_s"])
    if not MIN_ROUTING_TIMEOUT_S <= timeout_s <= MAX_ROUTING_TIMEOUT_S:
        raise ValueError(
            f"{where}.timeout_s must be in [{MIN_ROUTING_TIMEOUT_S:g}, {MAX_ROUTING_TIMEOUT_S:g}]:"
            " a cold classification ran past 1.5 s"
        )
    return timeout_s


def _routing(raw: dict[str, Any]) -> Routing:
    routing = Routing(
        provider=_provider(raw, "routing"),
        timeout_s=_timeout(raw, "routing"),
        pipeline=raw["pipeline"],
        pending_question_s=float(raw["pending_question_s"]),
        settle_s=float(raw["settle_s"]),
    )
    if not routing.pipeline:
        raise ValueError("routing needs a pipeline")
    if not 0 < routing.pending_question_s < 300:
        raise ValueError("routing.pending_question_s must be in (0, 300): Home Assistant forgets after 5 minutes")
    # A longer wait would leave the settling cap (live._SETTLE_MAX_S) a single window.
    if not 0 < routing.settle_s <= 1:
        raise ValueError("routing.settle_s must be in (0, 1]")
    return routing


def _home_assistant(raw: dict[str, Any]) -> HomeAssistantAudio:
    where = "home_assistant.shadow"
    shadow = raw.get("shadow")
    home = HomeAssistantAudio(
        pipeline=raw["pipeline"],
        read_only_tools=frozenset(raw["read_only_tools"]),
        non_home_tools=frozenset(raw.get("non_home_tools", [])),
        barge_in=raw["barge_in"],
        shadow=RoutingShadow(_provider(shadow, where), _timeout(shadow, where)) if shadow else None,
    )
    if not home.pipeline:
        raise ValueError("home_assistant needs a pipeline")
    if not isinstance(home.barge_in, bool):
        raise ValueError("home_assistant.barge_in must be true or false")
    if overlap := home.read_only_tools & home.non_home_tools:
        raise ValueError(f"tools both read-only and non-home: {', '.join(sorted(overlap))}")
    return home


def _device(raw: dict[str, Any]) -> Device:
    return Device(
        raw["name"], raw["address"], raw["area"], raw["call_action"], raw.get("home_assistant_device_id") or None
    )


def load(path: Path) -> Config:
    raw = json.loads(path.read_text())
    devices = [_device(d) for d in raw["devices"]]
    if "decisions_shadow" in raw:
        # 6c02e0d's top-level shadow, never deployed; a config naming it must not pass silently.
        raise ValueError("decisions_shadow is home_assistant.shadow now")
    if raw.get("routing") and raw.get("home_assistant"):
        # Home Assistant would act twice: once on the gated text request, once on the audio.
        raise ValueError("routing (gated) and home_assistant (parallel) are exclusive modes")
    routing = _routing(raw["routing"]) if raw.get("routing") else None
    home = _home_assistant(raw["home_assistant"]) if raw.get("home_assistant") else None
    mode = "routing" if routing else "home_assistant" if home else None
    if mode and (unplaced := [d.name for d in devices if d.home_assistant_device_id is None]):
        raise ValueError(f"{mode} needs home_assistant_device_id for {', '.join(unplaced)}")
    return Config(
        listen_host=raw["listen_host"],
        listen_port=int(raw["listen_port"]),
        device_token=_read_secret(raw["device_token_file"]),
        openai_api_key=_read_secret(raw["openai_api_key_file"]),
        devices=devices,
        live=_live(raw["live"]),
        openclaw=_openclaw(raw["openclaw"]),
        calls=_calls(raw["calls"]),
        idle_timeout_s=float(raw["idle_timeout_s"]),
        max_conversation_s=float(raw["max_conversation_s"]),
        recordings_dir=Path(raw["recordings_dir"]) if raw.get("recordings_dir") else None,
        routing=routing,
        home_assistant=home,
    )
