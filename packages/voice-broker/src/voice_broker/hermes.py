"""The Hermes agent, reached through its same-host bridge (hermes_bridge.py).

Hermes's own HTTP API (/v1/responses) refuses to write a Telegram session, and
consults are turns of the owner's Telegram conversation, so that voice and
Telegram share one context. The bridge runs as the Hermes user beside the
gateway and takes a consult into that session through the gateway's own
client. The broker reaches it over a Unix socket only its group can open.

The bridge's HTTP contract (hermes_bridge.py implements it):
- POST /consult {submission_id, task, instructions} -> 200 {text}, or an error
  status with {error}. 503: nothing was submitted. 502: the turn ended without
  an answer. 504: whether the turn ran or ended is unknown.
- GET /history?limit=N -> 200 {messages: [{role, text, timestamp}]}, the
  newest N messages as the gateway displays them, timestamps in seconds.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

import httpx2

from .agent import ConsultFailed, HistoryUnavailable, Observe, Role, Turn, newest
from .config import Hermes as HermesConfig

log = logging.getLogger(__name__)

# One consult: longer than the bridge's own bound on a turn (hermes_bridge._CONSULT_TIMEOUT_S), so
# the bridge says whether the turn ended before the broker stops waiting.
_CONSULT_TIMEOUT_S = 95.0
# One read of the session's history.
_HISTORY_TIMEOUT_S = 10.0
# History roles whose text is conversation; tool rows have roles of their own.
_ROLES: dict[str, Role] = {"user": "user", "assistant": "assistant"}


class Hermes:
    def __init__(self, config: HermesConfig) -> None:
        self._config = config
        self._http = httpx2.AsyncClient(
            transport=httpx2.AsyncHTTPTransport(uds=str(config.socket)),
            # The host is never resolved: every request goes to the socket.
            base_url="http://hermes",
            timeout=_HISTORY_TIMEOUT_S,
        )

    @property
    def observer(self) -> Observe | None:
        # Hermes has no separate observer session; parallel mode remains disabled.
        return None

    def conversation(self, conversation_id: str) -> Conversation:
        return Conversation(self, conversation_id)

    async def consult(self, task: str, submission_id: str) -> str:
        """The agent's answer to `task`, submitted as `submission_id`.

        Exactly one request, never retried: a consult that failed or timed out
        may still have run, and may have acted.
        """
        try:
            response = await self._http.post(
                "/consult",
                json={"submission_id": submission_id, "task": task, "instructions": self._config.instructions},
                timeout=_CONSULT_TIMEOUT_S,
            )
        except httpx2.HTTPError as e:
            raise ConsultFailed(repr(e)) from e
        body = _json(response)
        if response.status_code != 200:
            error = body.get("error") if isinstance(body, dict) else None
            raise ConsultFailed(f"bridge answered {response.status_code}: {error!r}")
        answer = body.get("text") if isinstance(body, dict) else None
        if not isinstance(answer, str) or not answer.strip():
            raise ConsultFailed("the agent's turn ended with no text")
        answer = answer.strip()
        log.info("consult -> %s", answer)
        return answer

    async def recent(self) -> list[Turn]:
        """The newest turns of the agent's conversation, within the configured history bounds."""
        history = self._config.history
        if history.max_messages <= 0 or history.max_chars <= 0:
            return []
        try:
            response = await self._http.get("/history", params={"limit": history.max_messages})
        except httpx2.HTTPError as e:
            raise HistoryUnavailable(repr(e)) from e
        body = _json(response)
        if response.status_code != 200:
            error = body.get("error") if isinstance(body, dict) else None
            raise HistoryUnavailable(f"bridge answered {response.status_code}: {error!r}")
        messages = body.get("messages") if isinstance(body, dict) else None
        if not isinstance(messages, list):
            raise HistoryUnavailable(f"history messages are {type(messages).__name__}")
        since = time.time() - history.max_age_s
        return newest(_turns(messages[-history.max_messages :], since), history.max_chars)

    async def aclose(self) -> None:
        await self._http.aclose()


class Conversation:
    """The consults of one spoken conversation: turns of the session the bridge serves."""

    def __init__(self, hermes: Hermes, conversation_id: str) -> None:
        self._hermes = hermes
        self._id = conversation_id

    async def consult(self, task: str) -> str:
        # New for every consult and sent once: the gateway admits a submission ID once, so the ID
        # is what the bridge recovers the turn by after a lost connection, never a second turn.
        return await self._hermes.consult(task, f"voice-broker:{self._id}:{uuid.uuid4().hex}")

    async def recent(self) -> list[Turn]:
        return await self._hermes.recent()


def _json(response: httpx2.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _turns(messages: list[Any], since: float) -> list[Turn]:
    """The conversation in `messages`, in order: each user or assistant message's text, from `since` on."""
    turns: list[Turn] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = _ROLES.get(message.get("role"))
        timestamp = message.get("timestamp")
        text = message.get("text")
        if role is None or (isinstance(timestamp, int | float) and timestamp < since):
            continue
        if isinstance(text, str) and (text := text.strip()):
            turns.append((role, text))
    return turns
