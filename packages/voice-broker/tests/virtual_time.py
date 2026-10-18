"""Coroutines on virtual time: whenever nothing is ready to run, the clock jumps to the next timer."""

from __future__ import annotations

import asyncio
import selectors
from collections.abc import Coroutine
from typing import Any


class _Selector(selectors.DefaultSelector):
    def __init__(self) -> None:
        super().__init__()
        self.now = 0.0

    def select(self, timeout: float | None = None) -> list[tuple[selectors.SelectorKey, int]]:
        ready = super().select(0)
        if ready or timeout == 0:
            return ready
        if timeout is None:
            raise RuntimeError("every task is waiting and no timer is due")
        self.now += timeout
        return ready


class _Loop(asyncio.SelectorEventLoop):
    def __init__(self) -> None:
        self._virtual = _Selector()
        super().__init__(self._virtual)

    def time(self) -> float:
        return self._virtual.now


def run[T](main: Coroutine[Any, Any, T]) -> T:
    """Runs `main` to completion, every wait taking no real time."""
    with asyncio.Runner(loop_factory=_Loop) as runner:
        return runner.run(main)
