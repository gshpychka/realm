"""Delegated tasks and conversation history."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from .config import AgentConfig

Role = Literal["user", "assistant"]
# A conversation turn's role and text.
Turn = tuple[Role, str]
# Read-only task verification with an optional discrepancy to report. Raises ConsultFailed.
Observe = Callable[[str], Awaitable[str | None]]


class ConsultFailed(Exception):
    """The consultation's answer is unavailable."""


class HistoryUnavailable(Exception):
    """Conversation history is unavailable."""


class Conversation(Protocol):
    """The consults of one spoken conversation."""

    async def consult(self, task: str) -> str:
        """The agent's answer to `task`, to be spoken; one consult at a time. Raises ConsultFailed."""
        ...

    async def recent(self) -> list[Turn]:
        """The newest conversation turns. Raises HistoryUnavailable."""
        ...


class Agent(Protocol):
    @property
    def observer(self) -> Observe | None:
        """Optional read-only verification of a task's observed outcome."""
        ...

    def conversation(self, conversation_id: str) -> Conversation:
        """The consults of one spoken conversation, `conversation_id` unique to it."""
        ...

    async def aclose(self) -> None: ...


def create_agent(config: AgentConfig) -> Agent:
    """The configured conversational agent."""
    from .config import Hermes, OpenClaw

    match config:
        case OpenClaw():
            from .openclaw import OpenClaw as OpenClawAgent

            return OpenClawAgent(config)
        case Hermes():
            from .hermes import Hermes as HermesAgent

            return HermesAgent(config)


def newest(turns: list[Turn], max_chars: int) -> list[Turn]:
    """The longest tail of `turns` whose text fits in `max_chars`."""
    kept = 0
    chars = 0
    for _, text in reversed(turns):
        chars += len(text)
        if chars > max_chars:
            break
        kept += 1
    return turns[len(turns) - kept :]
