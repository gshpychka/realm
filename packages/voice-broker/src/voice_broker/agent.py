"""The agent that carries out the work GPT-Live delegates, whichever backend it is.

Two adapters implement it: OpenClaw (openclaw.py) and Hermes (hermes.py).
config.Config.agent picks one, and create_agent builds it. The rest of the
broker sees only what this module defines.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from .config import AgentConfig

Role = Literal["user", "assistant"]
# One message of a conversation: who said it and what.
Turn = tuple[Role, str]
# A read-only check of what Home Assistant did: None, or a discrepancy to tell. Raises ConsultFailed.
Observe = Callable[[str], Awaitable[str | None]]


class ConsultFailed(Exception):
    """The agent gave no answer."""


class HistoryUnavailable(Exception):
    """The agent's conversation could not be read."""


class Conversation(Protocol):
    """The consults of one spoken conversation."""

    async def consult(self, task: str) -> str:
        """The agent's answer to `task`, to be spoken; one consult at a time. Raises ConsultFailed."""
        ...

    async def recent(self) -> list[Turn]:
        """The newest turns of the agent's conversation, what the voice starts with. Raises HistoryUnavailable."""
        ...


class Agent(Protocol):
    @property
    def observer(self) -> Observe | None:
        """The read-only check of Home Assistant's work; None when the agent has none configured."""
        ...

    def conversation(self, conversation_id: str) -> Conversation:
        """The consults of one spoken conversation, `conversation_id` unique to it."""
        ...

    async def aclose(self) -> None: ...


def create_agent(config: AgentConfig) -> Agent:
    """The agent `config` describes. Each adapter is imported only when chosen."""
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
