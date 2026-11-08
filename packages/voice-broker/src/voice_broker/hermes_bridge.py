"""Agent consultations and history for a shared conversation."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
import signal
import stat
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Protocol

log = logging.getLogger("hermes_bridge")

_CONSULT_TIMEOUT_S = 90.0
_HISTORY_TIMEOUT_S = 8.0
_TICK_S = 0.25
_TICK_MAX_S = 5.0
_RECONNECT_S = 0.5
_MAX_BODY = 256 * 1024

# Submission IDs use a log-safe alphabet.
_SUBMISSION_ID = re.compile(r"[A-Za-z0-9:._-]{1,200}")
_CONSULT_KEYS = frozenset({"submission_id", "task", "instructions"})
_CHAT_ID = re.compile(r"[1-9][0-9]*")
_PENDING = frozenset({"queued", "started"})


class Unavailable(Exception):
    """The task has not been submitted."""


class Failed(Exception):
    """A terminal consultation whose answer is unavailable."""


class Uncertain(Exception):
    """The consultation's execution outcome is unknown."""


class Client(Protocol):
    """An authenticated session connection with RPC and completion events."""

    events: asyncio.Queue[Any]

    async def rpc(self, method: str, **params: Any) -> Any: ...


Connect = Callable[[], AbstractAsyncContextManager[Client]]
# The active session ID for a route. Raises Unavailable.
Resolve = Callable[[], Awaitable[str]]


class _Lost(Exception):
    """The consultation transport is disconnected."""


@dataclass
class _Attempt:
    # Submission delivery may have occurred.
    sent: bool = False
    # The submission acknowledgment is unavailable.
    ambiguous: bool = False


@dataclass
class Bridge:
    connect: Connect
    resolve: Resolve
    # A request refusal before execution.
    refused: type[Exception]
    # An interrupted connection with an uncertain response.
    lost: type[Exception]
    consult_timeout_s: float = _CONSULT_TIMEOUT_S
    history_timeout_s: float = _HISTORY_TIMEOUT_S
    tick_s: float = _TICK_S
    reconnect_s: float = _RECONNECT_S

    async def consult(self, submission_id: str, task: str, instructions: str) -> str:
        """The answer of the session's turn for `task`. Raises Unavailable, Failed or Uncertain."""
        attempt = _Attempt()
        try:
            async with asyncio.timeout(self.consult_timeout_s):
                return await self._consult(attempt, submission_id, task, instructions)
        except TimeoutError:
            if not attempt.sent:
                raise Unavailable("timeout") from None
            raise Uncertain("timeout") from None
        except Uncertain as e:
            if not attempt.sent:
                raise Unavailable(str(e)) from e
            raise
        except (Unavailable, Failed):
            raise
        except Exception as e:
            log.exception("consult %s failed", submission_id)
            raise (Uncertain if attempt.sent else Unavailable)(f"bridge_error:{type(e).__name__}") from e

    async def _consult(self, attempt: _Attempt, submission_id: str, task: str, instructions: str) -> str:
        session_id = await self.resolve()
        canonical: str | None = None
        admission: str | None = None
        delay = self.reconnect_s
        while True:
            try:
                async with self.connect() as client:
                    resumed = _string(
                        await client.rpc("session.resume", session_id=session_id, omit_messages=True), "session_id"
                    )
                    # Recovery preserves the admitted session identity.
                    if canonical is not None and resumed != canonical:
                        raise Uncertain("session_changed")
                    canonical = resumed
                    if admission is None:
                        attempt.sent = True
                        receipt = await client.rpc(
                            "prompt.submit",
                            session_id=canonical,
                            submission_id=submission_id,
                            text=task,
                            api_text=f"{instructions}\n\n{task}" if instructions else task,
                        )
                        admission = _string(receipt, "admission_id")
                        log.info("consult %s admitted as %s in %s", submission_id, admission, canonical)
                    else:
                        receipt = await self._receipt(client, canonical, admission)
                    return await self._settle(client, canonical, admission, receipt)
            except self.refused as e:
                if attempt.ambiguous or admission is not None:
                    raise Uncertain(f"refused:{e}") from e
                raise Unavailable(str(e)) from e
            except (self.lost, _Lost, Unavailable, TimeoutError) as e:
                if not attempt.sent:
                    if isinstance(e, Unavailable):
                        raise
                    raise Unavailable(f"gateway:{type(e).__name__}") from e
                if admission is None:
                    attempt.ambiguous = True
                log.warning("consult %s lost its connection (%s); attaching again", submission_id, e)
                await asyncio.sleep(delay)
                delay = min(delay * 2, _TICK_MAX_S)

    async def _settle(self, client: Client, session_id: str, admission: str, receipt: Any) -> str:
        tick = self.tick_s
        while _status(receipt) in _PENDING:
            try:
                async with asyncio.timeout(tick):
                    await _completion(client, admission)
            except TimeoutError:
                tick = min(tick * 2, _TICK_MAX_S)
            receipt = await self._receipt(client, session_id, admission)
        status = _status(receipt)
        if status != "terminal":
            raise Uncertain(f"status:{status}")
        if "result" not in receipt:
            receipt = await self._receipt(client, session_id, admission)
        return _answer(receipt)

    async def _receipt(self, client: Client, session_id: str, admission: str) -> Any:
        return await client.rpc("prompt.receipt", session_id=session_id, admission_id=admission, include_result=True)

    async def history(self, limit: int) -> list[dict[str, Any]]:
        """The newest `limit` conversation messages. Raises Unavailable."""
        try:
            async with asyncio.timeout(self.history_timeout_s):
                session_id = await self.resolve()
                async with self.connect() as client:
                    canonical = await self._attach(client, session_id)
                    history = await client.rpc("session.history", session_id=canonical)
        except Unavailable:
            raise
        except Exception as e:
            log.warning("history unreadable", exc_info=not isinstance(e, self.lost | TimeoutError))
            raise Unavailable(f"history:{type(e).__name__}") from e
        messages = history.get("messages") if isinstance(history, dict) else None
        if not isinstance(messages, list):
            raise Unavailable("history:malformed")
        return [_row(message) for message in messages[-limit:] if isinstance(message, dict)]

    async def health(self) -> dict[str, Any]:
        """Consultation readiness and the active session ID. Raises Unavailable."""
        try:
            async with asyncio.timeout(self.history_timeout_s):
                session_id = await self.resolve()
                async with self.connect() as client:
                    return {"ready": True, "session_id": await self._attach(client, session_id)}
        except Unavailable:
            raise
        except Exception as e:
            log.warning("health check failed", exc_info=not isinstance(e, self.lost | TimeoutError))
            raise Unavailable(f"health:{type(e).__name__}") from e

    async def _attach(self, client: Client, session_id: str) -> str:
        try:
            return _string(await client.rpc("session.resume", session_id=session_id, omit_messages=True), "session_id")
        except Uncertain as e:
            raise Unavailable(str(e)) from e


async def _completion(client: Client, admission: str) -> None:
    """Completion of `admission`. Raises _Lost."""
    while True:
        event = await client.events.get()
        if isinstance(event, Exception):
            raise _Lost(str(event))
        frame = event.get("params") if isinstance(event, dict) else None
        if not isinstance(frame, dict) or frame.get("type") != "message.complete":
            continue
        payload = frame.get("payload")
        named = {frame.get("admission_id"), payload.get("admission_id") if isinstance(payload, dict) else None}
        if admission in named:
            return


def _status(receipt: Any) -> Any:
    return receipt.get("status") if isinstance(receipt, dict) else None


def _answer(receipt: dict[str, Any]) -> str:
    """The final answer of a completed consultation. Raises Failed."""
    outcome = receipt.get("outcome")
    if outcome != "completed":
        raise Failed(str(outcome))
    result = receipt.get("result")
    if not isinstance(result, dict):
        raise Failed("no_result")
    # Embedded failure flags take precedence over a completed outcome.
    if result.get("failed") or result.get("error"):
        raise Failed("failed")
    if result.get("interrupted"):
        raise Failed("interrupted")
    text = result.get("final_response")
    if not isinstance(text, str) or not text.strip():
        raise Failed("empty")
    return text.strip()


def _string(answer: Any, key: str) -> str:
    value = answer.get(key) if isinstance(answer, dict) else None
    if not isinstance(value, str) or not value:
        raise Uncertain(f"malformed:{key}")
    return value


def _row(message: dict[str, Any]) -> dict[str, Any]:
    """A conversation message's role, text and timestamp."""
    text, timestamp = message.get("text"), message.get("timestamp")
    return {
        "role": message.get("role"),
        "text": text if isinstance(text, str) else None,
        "timestamp": timestamp if isinstance(timestamp, int | float) and not isinstance(timestamp, bool) else None,
    }


@asynccontextmanager
async def gateway(home: Path) -> AsyncIterator[Any]:
    """An authenticated connection to the active session service. Raises Unavailable."""
    from hermes_cli.gateway_client import connect_gateway
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint

    found = await asyncio.to_thread(discover_gateway_endpoint, home)
    if not attachable(found):
        raise Unavailable(f"gateway_{found.state}")
    # An explicit endpoint confines attachment to an existing service.
    async with connect_gateway(endpoint=found.endpoint) as client:
        yield client


def resolve_session(home: Path, route: str) -> str:
    """The active session ID for `route`. Raises Unavailable."""
    from hermes_state import SessionDB

    db = SessionDB(db_path=home / "state.db", read_only=True)
    try:
        row = db.find_latest_gateway_session_for_peer(source=route.split(":")[2], session_key=route)
    finally:
        db.close()
    session_id = row.get("id") if isinstance(row, dict) else None
    if not isinstance(session_id, str) or not session_id:
        raise Unavailable("no_session")
    return session_id


def telegram_route(chat_id_file: Path) -> str:
    """The owner's Telegram direct-message route."""
    chat_id = chat_id_file.read_text().strip()
    if not _CHAT_ID.fullmatch(chat_id):
        raise ValueError(f"{chat_id_file} holds no Telegram user's chat ID")
    return f"agent:main:telegram:dm:{chat_id}"


def make_app(bridge: Bridge) -> Any:
    """The consultation, history and readiness API."""
    from aiohttp import web

    def error(status: int, code: str) -> web.Response:
        return web.json_response({"error": code}, status=status)

    async def consult(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            return error(400, "invalid_json")
        if (
            not isinstance(body, dict)
            or set(body) != _CONSULT_KEYS
            or not isinstance(body["submission_id"], str)
            or not _SUBMISSION_ID.fullmatch(body["submission_id"])
            or not isinstance(body["task"], str)
            or not body["task"].strip()
            or not isinstance(body["instructions"], str)
        ):
            return error(400, "invalid_consult")
        try:
            text = await bridge.consult(body["submission_id"], body["task"], body["instructions"])
        except Unavailable as e:
            log.warning("consult %s: nothing submitted: %s", body["submission_id"], e)
            return error(503, str(e))
        except Failed as e:
            log.warning("consult %s ended without an answer: %s", body["submission_id"], e)
            return error(502, str(e))
        except Uncertain as e:
            log.warning("consult %s uncertain: %s", body["submission_id"], e)
            return error(504, "uncertain")
        return web.json_response({"text": text})

    async def history(request: web.Request) -> web.Response:
        try:
            limit = int(request.query["limit"])
        except (KeyError, ValueError):
            return error(400, "invalid_limit")
        if limit < 1:
            return error(400, "invalid_limit")
        try:
            return web.json_response({"messages": await bridge.history(limit)})
        except Unavailable as e:
            log.warning("history: %s", e)
            return error(503, str(e))

    async def health(request: web.Request) -> web.Response:
        try:
            return web.json_response(await bridge.health())
        except Unavailable as e:
            return error(503, str(e))

    app = web.Application(client_max_size=_MAX_BODY)
    app.router.add_post("/consult", consult)
    app.router.add_get("/history", history, allow_head=False)
    app.router.add_get("/health", health, allow_head=False)
    return app


async def serve(app: Any, socket: Path) -> Any:
    """A local application runner with owner/group socket access."""
    from aiohttp import web

    runner = web.AppRunner(app)
    await runner.setup()
    # Cleanup is restricted to socket paths.
    if socket.is_socket():
        socket.unlink()
    # Owner/group access applies from socket creation.
    umask = os.umask(0o117)
    try:
        await web.UnixSite(runner, str(socket)).start()
    finally:
        os.umask(umask)
    socket.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)
    return runner


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="hermes_bridge", description=__doc__.split("\n\n")[0])
    parser.add_argument("--socket", type=Path, required=True, help="the Unix socket to serve on")
    parser.add_argument("--home", type=Path, required=True, help="the Hermes home (HERMES_HOME)")
    route = parser.add_mutually_exclusive_group(required=True)
    route.add_argument("--session-key", help="the gateway route key whose active session consults are turns of")
    route.add_argument(
        "--telegram-chat-id-file", type=Path, help="a file holding the owner's Telegram chat ID: their DM's route"
    )
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args(argv)


async def _run(bridge: Bridge, socket: Path) -> None:
    runner = await serve(make_app(bridge), socket)
    log.info("serving on %s", socket)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await runner.cleanup()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(levelname)s %(name)s: %(message)s")
    home = args.home.absolute()
    # Authentication and session lookup share one home.
    if (named := os.environ.get("HERMES_HOME")) and Path(named).absolute() != home:
        raise SystemExit(f"HERMES_HOME is {named}, not --home {home}")
    os.environ["HERMES_HOME"] = str(home)
    route = args.session_key or telegram_route(args.telegram_chat_id_file)
    if len(route.split(":")) < 4 or not route.startswith("agent:"):
        raise SystemExit(f"{route!r} is no gateway route key (agent:<namespace>:<platform>:...)")

    from hermes_cli.gateway_client import GatewayClientError, GatewayRPCError

    bridge = Bridge(
        connect=partial(gateway, home),
        resolve=partial(asyncio.to_thread, resolve_session, home, route),
        refused=GatewayRPCError,
        lost=GatewayClientError,
    )
    asyncio.run(_run(bridge, args.socket))


if __name__ == "__main__":
    main()
