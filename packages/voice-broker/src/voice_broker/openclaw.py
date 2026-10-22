"""The OpenClaw agent, which carries out the work GPT-Live delegates.

Each consult is one agent turn on the gateway's OpenResponses endpoint
(https://docs.openclaw.ai/gateway/openresponses-http-api), in the session the
config names. The gateway takes the agent, and with it the agent's tools, from
that session key's `agent:<id>:` prefix alone: `model` and the request's own
tools don't narrow the agent's native or MCP tools. The voice starts with the
newest turns of the history session.

Consults are turns of the agent's own session (agent:main:main), so a spoken
conversation shares the agent's context with Telegram. Only with an overflow
configured, and only when the broker's advisory estimate finds that session
too full for a conversation's first consult, does the conversation get a
session of its own, of the same agent (Conversation below).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import quote

import httpx2
from openai import AsyncOpenAI, OpenAIError

from .config import OpenClaw as OpenClawConfig

log = logging.getLogger(__name__)

# The gateway's default agent.
_AGENT = "openclaw"
# One agent turn, which may run several tools.
_TIMEOUT_S = 90.0
# One read of the session's transcript.
_HISTORY_TIMEOUT_S = 10.0
# One observation: a few reads of the home's state.
_OBSERVE_TIMEOUT_S = 45.0

# The gateway's compaction reserve: a prompt past window - min(max(reserve, 20000), window / 4) is
# compacted first (agents/agent-settings.ts DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
# agents/agent-compaction-constants.ts, preemptive-compaction.ts at e178c39e). The reserve itself
# is 16384 unless a settings.json raises it; agents.defaults.compaction.reserveTokens is a dead
# key, and on hoard there is no settings.json (checked 2026-10-17), so the floor is the reserve.
_RESERVE_FLOOR_TOKENS = 20_000
_MAX_RESERVE_RATIO = 0.25
# Newest transcript messages read for the latest model call's usage: tool loops record one per call.
_USAGE_MESSAGES = 20
# sessions_list shows the agent's main session as this, not by its key (agents/tools/sessions-resolution.ts).
_MAIN_ALIAS = "main"

# The observer's answer, as the one client tool it must call.
_VERDICT_TOOL: dict[str, Any] = {
    "type": "function",
    "name": "home_verdict",
    "description": "Report whether the home's current state matches what the user asked for.",
    "parameters": {
        "type": "object",
        "properties": {
            "matches": {"type": "boolean", "description": "True when the state matches, or when it can't be told."},
            "discrepancy": {
                "type": "string",
                "description": "When it does not match: one short spoken sentence for the user saying what differs.",
            },
        },
        "required": ["matches"],
        "additionalProperties": False,
    },
}
_OBSERVER_INSTRUCTIONS = (
    "You check, read-only, what Home Assistant just did after a spoken request. Home Assistant alone acts on the "
    "home; you never change anything and never ask it to. Read the current state of the devices involved, then "
    "call home_verdict once. Report matches=false only for a clear, concrete difference between what the user "
    "asked and the state now, such as the wrong room's light or a device left off. Speech recognition can "
    "mishear, so when the request is unclear, or the state can't be read, report matches=true."
)

Role = Literal["user", "assistant"]
# One message of a conversation: who said it and what.
Turn = tuple[Role, str]
# Transcript roles whose text is conversation; tool results have a role of their own.
_ROLES: dict[str, Role] = {"user": "user", "assistant": "assistant"}


class ConsultFailed(Exception):
    """The agent gave no answer."""


class HistoryUnavailable(Exception):
    """The agent's conversation could not be read."""


class _UsageUnknown(Exception):
    """The session's context use or budget could not be told."""


@dataclass(frozen=True, slots=True)
class Fit:
    """Whether a consult fits the agent session's context before the gateway would compact it.

    Its str is numbers only, for the log.
    """

    fits: bool
    # Tokens the session's next prompt carries before the consult; None when unknown.
    used: int | None = None
    # An upper bound of the consult's own tokens, with the margin for what the gateway counts again.
    request: int = 0
    # The prompt size past which the gateway compacts first; None when unknown.
    threshold: int | None = None
    # Why the use is unknown, when it is.
    unknown: str | None = None

    def __str__(self) -> str:
        if self.unknown is not None:
            return f"context use unknown ({self.unknown}), so {'fits' if self.fits else 'full'} by policy"
        return f"{self.used} + {self.request} of {self.threshold} tokens: {'fits' if self.fits else 'full'}"


class OpenClaw:
    def __init__(self, config: OpenClawConfig, http_client: httpx2.AsyncClient | None = None) -> None:
        self._config = config
        self._http = http_client or httpx2.AsyncClient()
        self._client = AsyncOpenAI(
            base_url=f"{config.url}/v1",
            api_key=config.token,
            default_headers={
                "x-openclaw-session-key": config.session_key,
                **({} if config.agent is None else {"x-openclaw-agent-id": config.agent}),
                **({} if config.model is None else {"x-openclaw-model": config.model}),
            },
            timeout=_TIMEOUT_S,
            # An agent turn can act on the home, so a retried one could act twice.
            max_retries=0,
            http_client=self._http,
        )

    @property
    def config(self) -> OpenClawConfig:
        return self._config

    async def preflight(self, task: str) -> Fit:
        """Whether a consult of `task` likely fits the agent session before the gateway would compact it.

        An estimate, advisory and not atomic: it reads the last recorded use,
        and the consult follows as a separate request. Another turn can land
        in between, and the gateway renders and measures the real prompt only
        then; no gateway endpoint reserves room and submits in one step
        (OpenClaw e178c39e). Off unless the module's overflow.enable is on.

        Approximates the gateway's own check before each prompt
        (embedded-agent-runner/run/preemptive-compaction.ts at e178c39e): the
        newest model call's measured prompt and output, then 1.2 times a local
        estimate of what follows it: the rendered system prompt again, and the
        newer messages. The parts:
        - the window: the running gateway's own for the session (the
          sessions_list tool, the row sessions.list projects; a separate
          process's view of the store can lack the model's window and show a
          default);
        - the measured use: the newest call's contextUsage from the transcript,
          or the row's last prompt when that is larger;
        - the newer messages: their bytes as the transcript shows them;
        - the consult itself: its UTF-8 bytes, which no token spans less of;
        - the system prompt the gateway counts again: overflow.margin_tokens,
          which this endpoint can't read.
        Unknown use is told as such and decided by overflow.when_unknown, never
        guessed. Unknown means: a read failed, the gateway gave no window, the
        newest call's usage is not measured (the gateway then estimates the
        whole transcript), none of the messages read records a call, or a newer
        message may be shown cut or without its images, so its size can't be
        bounded.
        """
        overflow = self._config.overflow
        assert overflow is not None
        request = len(self._config.instructions.encode()) + len(task.encode())
        try:
            (window, prompt), (measured, after) = await asyncio.gather(self._row(), self._newest_usage())
        except _UsageUnknown as e:
            return Fit(overflow.fits_when_unknown, request=request, unknown=str(e))
        used = max(measured, prompt or 0) + after
        threshold = window - min(_RESERVE_FLOOR_TOKENS, int(window * _MAX_RESERVE_RATIO))
        needed = request + overflow.margin_tokens
        return Fit(used + needed < threshold, used=used, request=needed, threshold=threshold)

    async def _row(self) -> tuple[int, int | None]:
        """The gateway's window for the agent session, and its last prompt's tokens when it has them."""
        session_key = self._config.session_key
        agent = session_key.split(":")[1]
        # The tool shows the agent's main session as "main" (_MAIN_ALIAS), any other by its key.
        names = {session_key, _MAIN_ALIAS} if session_key == f"agent:{agent}:{_MAIN_ALIAS}" else {session_key}
        try:
            response = await self._http.post(
                f"{self._config.url}/tools/invoke",
                json={
                    "tool": "sessions_list",
                    "args": {"agentId": agent, "search": session_key, "limit": 5},
                    "sessionKey": session_key,
                },
                headers={"Authorization": f"Bearer {self._config.token}"},
                timeout=_HISTORY_TIMEOUT_S,
            )
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict) or body.get("ok") is not True:
                raise _UsageUnknown("sessions_list refused")
            rows = body["result"]["details"]["sessions"]
            if not isinstance(rows, list):
                raise TypeError(type(rows).__name__)
            matching = [
                r
                for r in rows
                if isinstance(r, dict)
                and isinstance(r.get("key"), str)
                and r["key"] in names
                and r.get("agentId") == agent
            ]
        except (httpx2.HTTPError, LookupError, TypeError, ValueError) as e:
            raise _UsageUnknown(f"sessions_list: {type(e).__name__}") from e
        if len(matching) != 1:
            raise _UsageUnknown(f"{len(matching)} rows for the session")
        (row,) = matching
        if (window := _tokens(row.get("contextTokens"))) is None or window == 0:
            raise _UsageUnknown("no window")
        return window, _tokens(row.get("totalTokens"))

    async def _newest_usage(self) -> tuple[int, int]:
        """The newest model call's measured prompt plus output tokens, and an upper bound of the
        tokens of the messages after it."""
        session = quote(self._config.session_key, safe="")
        try:
            response = await self._http.get(
                f"{self._config.url}/sessions/{session}/history",
                params={"limit": _USAGE_MESSAGES},
                headers={"Authorization": f"Bearer {self._config.token}"},
                timeout=_HISTORY_TIMEOUT_S,
            )
            response.raise_for_status()
            messages = response.json()["messages"]
            if not isinstance(messages, list):
                raise TypeError(type(messages).__name__)
        except (httpx2.HTTPError, LookupError, TypeError, ValueError) as e:
            raise _UsageUnknown(f"history: {type(e).__name__}") from e
        after = 0
        for message in reversed(messages):
            if not isinstance(message, dict):
                raise _UsageUnknown("malformed message")
            usage = message.get("usage")
            if message.get("role") == "assistant" and isinstance(usage, dict):
                # Any call the gateway recorded is its boundary (isProviderContextUsageBarrier):
                # measured, it counts; not measured, the gateway estimates everything instead.
                context = usage.get("contextUsage")
                total = _tokens(context.get("totalTokens")) if isinstance(context, dict) else None
                if total is None or context.get("state") != "available":
                    raise _UsageUnknown("newest call not measured")
                return total, after
            if not _bounded(message):
                raise _UsageUnknown("a newer message's size can't be bounded")
            after += len(json.dumps(message, ensure_ascii=False).encode())
        raise _UsageUnknown(f"no call in the newest {len(messages)} messages")

    def conversation(self, conversation_id: str) -> Conversation:
        """The consults of one spoken conversation, `conversation_id` unique to it."""
        return Conversation(self, conversation_id)

    async def consult(self, task: str, session_key: str | None = None) -> str:
        """The agent's answer to `task`, to be spoken: one turn of `session_key`, the config's when None.

        Exactly one request, never retried or resent elsewhere: a turn that failed
        or timed out may still have acted.
        """
        try:
            response = await self._client.responses.create(
                model=_AGENT,
                input=task,
                instructions=self._config.instructions,
                extra_headers=None if session_key is None else {"x-openclaw-session-key": session_key},
            )
        except OpenAIError as e:
            raise ConsultFailed(repr(e)) from e
        if response.status != "completed":
            log.warning("consult ended %s: %s", response.status, response.error)
        answer = response.output_text.strip()
        if not answer:
            raise ConsultFailed(f"the agent's turn ended {response.status} with no text")
        log.info("consult -> %s", answer)
        return answer

    async def observe(self, evidence: str) -> str | None:
        """Whether the home now matches what the user asked: None, or the discrepancy to tell them.

        A turn of the observer session. The agent reads the home with its own
        read-only tools, and answers through one client function call that
        tool_choice requires (openresponses-http-api.md), so its verdict is
        structured rather than parsed from prose. Raises ConsultFailed.
        """
        assert self._config.observer_session_key is not None
        try:
            response = await self._client.responses.create(
                model=_AGENT,
                input=evidence,
                instructions=_OBSERVER_INSTRUCTIONS,
                tools=[_VERDICT_TOOL],
                tool_choice={"type": "function", "name": _VERDICT_TOOL["name"]},
                extra_headers={"x-openclaw-session-key": self._config.observer_session_key},
                timeout=_OBSERVE_TIMEOUT_S,
            )
        except OpenAIError as e:
            raise ConsultFailed(repr(e)) from e
        calls = [item for item in response.output if getattr(item, "type", None) == "function_call"]
        if len(calls) != 1 or calls[0].name != _VERDICT_TOOL["name"]:
            raise ConsultFailed(f"the observer gave {len(calls)} verdicts")
        try:
            verdict = json.loads(calls[0].arguments)
            matches = verdict["matches"]
            discrepancy = str(verdict.get("discrepancy") or "").strip()
        except (ValueError, LookupError, TypeError) as e:
            raise ConsultFailed(f"malformed verdict: {type(e).__name__}") from e
        if matches is True:
            return None
        if matches is not False or not discrepancy:
            raise ConsultFailed("verdict without a discrepancy")
        log.info("observer -> %s", discrepancy)
        return discrepancy

    async def recent(self) -> list[Turn]:
        """The newest turns of the agent's conversation, within the configured history bounds.

        What the voice (GPT-Live) starts with: the history session's, whichever
        session the conversation's consults are turns of.
        """
        history = self._config.history
        return await self.newest_turns(self._config.history_session_key or self._config.session_key, history.max_chars)

    async def newest_turns(self, session_key: str, max_chars: int) -> list[Turn]:
        """The newest turns of `session_key`, within the history's message and age bounds and `max_chars`."""
        history = self._config.history
        session = quote(session_key, safe="")
        try:
            response = await self._http.get(
                f"{self._config.url}/sessions/{session}/history",
                params={"limit": history.max_messages},
                headers={"Authorization": f"Bearer {self._config.token}"},
                timeout=_HISTORY_TIMEOUT_S,
            )
            response.raise_for_status()
            messages = response.json()["messages"]
        except (httpx2.HTTPError, LookupError, TypeError, ValueError) as e:
            raise HistoryUnavailable(repr(e)) from e
        if not isinstance(messages, list):
            raise HistoryUnavailable(f"history messages are {type(messages).__name__}")
        turns = _turns(messages, since=time.time() - history.max_age_s)
        return _newest(turns, max_chars)

    async def aclose(self) -> None:
        # closes the HTTP client with it
        await self._client.close()


# Leads an overflow session's first consult, before the agent session's newest messages.
_HANDOFF_LEAD = (
    "Your main session is too full for this spoken conversation, so it continues in a session of its own."
    " The newest messages of your main session, for context; the request follows them:"
)


class Conversation:
    """The consults of one spoken conversation, all in one session.

    That is the agent's own session, unless the preflight before the
    conversation's first consult finds it too full (OpenClaw.preflight): then
    the conversation gets an overflow session, `<prefix><conversation id>`, of
    the same agent, which starts with a bounded handoff of the agent session's
    newest messages. The choice is made once, before any request of the
    conversation, and holds for its follow-ups: each consult quotes only what
    was said since the last answer, so the earlier turns must be in the
    session. A consult is never moved after its request, whatever became of
    it. The next conversation is placed afresh, in the agent's session again
    once it has room. The voice's own history (recent) is the agent session's
    either way.
    """

    def __init__(self, openclaw: OpenClaw, conversation_id: str) -> None:
        self._openclaw = openclaw
        self._id = conversation_id
        # None until the first consult is placed.
        self._session: str | None = None

    @property
    def id(self) -> str:
        return self._id

    @property
    def session_key(self) -> str | None:
        """The session the conversation's consults are turns of; None before the first."""
        return self._session

    async def consult(self, task: str) -> str:
        """The agent's answer to `task`, a turn of the conversation's session; one consult at a time."""
        if self._session is None:
            session = await self._place(task)
            if session != self._openclaw.config.session_key:
                task = await self._handoff(task)
            self._session = session
        return await self._openclaw.consult(task, self._session)

    async def recent(self) -> list[Turn]:
        return await self._openclaw.recent()

    async def _place(self, task: str) -> str:
        """The session for the conversation, decided before its first request."""
        config = self._openclaw.config
        if config.overflow is None:
            return config.session_key
        try:
            fit = await self._openclaw.preflight(task)
        except Exception as e:  # a bug here must not cost the user the request: the policy decides
            log.exception("preflight failed")
            fit = Fit(config.overflow.fits_when_unknown, unknown=f"preflight failed: {type(e).__name__}")
        if fit.fits:
            log.info("consults in %s: %s", config.session_key, fit)
            return config.session_key
        overflow = f"{config.overflow.session_prefix}{self._id}"
        log.info("consults in %s: %s", overflow, fit)
        return overflow

    async def _handoff(self, task: str) -> str:
        """`task` led by the agent session's newest messages, within the overflow's bound."""
        config = self._openclaw.config
        assert config.overflow is not None
        if config.overflow.handoff_max_chars == 0:
            return task
        try:
            turns = await self._openclaw.newest_turns(config.session_key, config.overflow.handoff_max_chars)
        except HistoryUnavailable as e:
            # The request matters more than its context: the overflow session starts without it.
            log.warning("overflow session starts without a handoff: %s", e)
            return task
        if not turns:
            return task
        said = "\n".join(f"{role}: {text}" for role, text in turns)
        return f"{_HANDOFF_LEAD}\n{said}\n\n{task}"


def _tokens(value: Any) -> int | None:
    """A token count the gateway gave, None unless it is a non-negative whole number."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if isinstance(value, float) and not (math.isfinite(value) and value.is_integer()):
        return None
    return int(value) if value >= 0 else None


# The history endpoint shows a text part cut to this many characters
# (gateway/chat-display-projection.helpers.ts DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS at e178c39e).
_HISTORY_TEXT_MAX_CHARS = 8_000


def _bounded(message: dict[str, Any]) -> bool:
    """Whether a message as the history endpoint shows it is as large as the agent's own copy: all text, none cut."""
    content = message.get("content")
    parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
    for part in parts:
        if not isinstance(part, dict) or part.get("type") != "text":
            # An image or other block: the endpoint may show less of it than the model gets.
            return False
        text = part.get("text")
        if not isinstance(text, str) or len(text) >= _HISTORY_TEXT_MAX_CHARS:
            return False
    return True


def _turns(messages: list[Any], since: float) -> list[Turn]:
    """The conversation in `messages`, in order: each user or assistant message's text, from `since` on."""
    turns: list[Turn] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = _ROLES.get(message.get("role"))
        timestamp = message.get("timestamp")
        if role is None or (isinstance(timestamp, int | float) and timestamp / 1000 < since):
            continue
        text = "\n".join(_texts(message.get("content")))
        if text:
            turns.append((role, text))
    return turns


def _texts(content: Any) -> list[str]:
    """The text parts of a message's content, blank ones left out."""
    parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
    texts = [
        part["text"].strip()
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
    ]
    return [text for text in texts if text]


def _newest(turns: list[Turn], max_chars: int) -> list[Turn]:
    """The longest tail of `turns` whose text fits in `max_chars`."""
    kept = 0
    chars = 0
    for _, text in reversed(turns):
        chars += len(text)
        if chars > max_chars:
            break
        kept += 1
    return turns[len(turns) - kept :]
