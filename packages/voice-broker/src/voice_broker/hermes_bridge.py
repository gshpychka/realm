"""The Hermes bridge: the voice broker's consults as turns of the owner's Telegram session.

Runs as a file on the Hermes package's own interpreter, as the Hermes user:

    .hermesVenv/bin/python -I hermes_bridge.py --socket PATH --home HERMES_HOME \\
        (--telegram-chat-id-file FILE | --session-key KEY)

so it imports nothing of the voice broker, and Hermes and aiohttp only where
they are used (the broker's tests import it without either). -I keeps the
file's own directory off sys.path: the broker's modules beside it (agent.py,
config.py, session.py) would shadow Hermes's packages of the same names.

Why a bridge: Hermes's HTTP API (/v1/responses) never writes a Telegram
session, and a spoken consult must be a turn of the owner's Telegram
conversation, with its model, tools and memory. The bridge reaches the
running gateway the way Hermes's own clients do, through
hermes_cli.gateway_client: the gateway's own authentication (a ticket minted on
its control socket, same OS user only), no API token, no second agent, no
gateway of its own.

A consult (POST /consult {submission_id, task, instructions}):
1. finds the route's active session in state.db, read-only
   (SessionDB.find_latest_gateway_session_for_peer, which respects /new resets);
2. attaches to it (session.resume), which names the canonical session: a
   compressed conversation's lineage root, its turns' target;
3. submits the task (prompt.submit) under the broker's submission ID. `text` is
   what the transcript keeps, `api_text` what the model reads: the
   instructions, then the task. The turn is an ordinary turn of the session:
   its replies, documents too, also reach the owner on Telegram;
4. waits for that admission's own message.complete frame, then reads its
   durable receipt (prompt.receipt, include_result): the receipt, never the
   frame, is the answer. Other turns of the session (the owner typing on
   Telegram) and this turn's interim frames are skipped. A frame can be lost
   in a replay gap, so the receipt is also read on a backed-off tick.

The gateway admits a submission ID once per session (hermes_state_runtime
admit_session_input: an exact replay returns the existing admission and never
runs it again). So after a lost connection the bridge attaches again and asks
by the same ID, never under a new one. Past the consult's bound, or when the
owner itself lost track of the turn (receipt status unknown), the answer is
"uncertain", never success.

Nothing here stops Hermes's work: a broker that hangs up or times out leaves
the turn running, and the bridge never interrupts the session or cancels an
admission (that would stop the owner's Telegram turns too). Leaving the
gateway's connection only detaches this viewer (gateway_client: "Closing a
viewer never stops its authority").

Approvals and clarifying questions stay the gateway's: nothing here answers
them. A turn waiting on one waits for the owner to answer on Telegram, and
the consult may run out of time meanwhile (504 uncertain).

HTTP, on a Unix socket only (mode 0660; systemd gives it the broker's group):
- POST /consult -> 200 {text}; 400 malformed; 503 {error} nothing was
  submitted; 502 {error} the turn ended without an answer; 504 {error:
  uncertain} whether it ran or ended is unknown.
- GET /history?limit=N -> 200 {messages: [{role, text, timestamp}]}: the
  newest N rows of the session as the gateway displays them (session.history),
  timestamps in seconds; 503 {error}.
- GET /health -> 200 {ready: true, session_id} after the same lookup and
  attach a consult makes, without a prompt or a model call; 503 {error}.
"""

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

# One consult, from the session lookup to the receipt with its answer. The broker waits a little
# longer (hermes._CONSULT_TIMEOUT_S), so it hears "uncertain" rather than a timeout of its own.
_CONSULT_TIMEOUT_S = 90.0
# One history read or health check.
_HISTORY_TIMEOUT_S = 8.0
# The first wait for a completion frame before the receipt is read anyway; doubled up to the most.
_TICK_S = 0.25
_TICK_MAX_S = 5.0
# The first wait before attaching again after a lost connection; doubled up to _TICK_MAX_S.
_RECONNECT_S = 0.5
# A request body, at most: a spoken task and the broker's instructions are a few KiB.
_MAX_BODY = 256 * 1024

# The broker's submission IDs (hermes.Conversation): bounded, and nothing a log or key would misread.
_SUBMISSION_ID = re.compile(r"[A-Za-z0-9:._-]{1,200}")
_CONSULT_KEYS = frozenset({"submission_id", "task", "instructions"})
# A Telegram DM's chat ID is its user's: a positive number (a group's is negative).
_CHAT_ID = re.compile(r"[1-9][0-9]*")
# Receipt statuses of an admission still in the gateway's hands (gateway/session_contract.py AdmissionReceipt).
_PENDING = frozenset({"queued", "started"})


class Unavailable(Exception):
    """Nothing was submitted: no gateway, no session, or the gateway refused the submission."""


class Failed(Exception):
    """The turn ended without an answer: its outcome, or why its result is none."""


class Uncertain(Exception):
    """The turn may have run, and whether it ended is unknown."""


class Client(Protocol):
    """hermes_cli.gateway_client.GatewayClient, as far as the bridge uses it."""

    # Event frames; a lost connection queues its error as one.
    events: asyncio.Queue[Any]

    async def rpc(self, method: str, **params: Any) -> Any: ...


# An attachment to the running gateway, for one request.
Connect = Callable[[], AbstractAsyncContextManager[Client]]
# The route's active session ID; raises Unavailable.
Resolve = Callable[[], Awaitable[str]]


class _Lost(Exception):
    """The connection was lost while waiting for events."""


@dataclass
class _Attempt:
    # The submission may have reached the gateway.
    sent: bool = False
    # A submit's answer was lost: the submission may be admitted, unseen.
    ambiguous: bool = False


@dataclass
class Bridge:
    connect: Connect
    resolve: Resolve
    # The owner's refusal of one request (GatewayRPCError): that request did nothing.
    refused: type[Exception]
    # A lost or failed connection (GatewayClientError): an answer it carried may be lost.
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
        except Exception as e:  # a bug, or a gateway answer of a shape never seen: never success
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
                    if canonical is not None and resumed != canonical:
                        # The admission's session is no longer what the route resolves to: its receipt
                        # can't be asked for there.
                        raise Uncertain("session_changed")
                    canonical = resumed
                    if admission is None:
                        attempt.sent = True
                        receipt = await client.rpc(
                            "prompt.submit",
                            session_id=canonical,
                            submission_id=submission_id,
                            text=task,
                            # The model's input: the instructions stay out of the transcript.
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
                # TimeoutError: one RPC's own deadline. The consult's bound cancels instead, and passes.
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
            # unknown: the owner lost the turn across a restart. Only the owner may resolve it.
            raise Uncertain(f"status:{status}")
        if "result" not in receipt:
            receipt = await self._receipt(client, session_id, admission)
        return _answer(receipt)

    async def _receipt(self, client: Client, session_id: str, admission: str) -> Any:
        return await client.rpc("prompt.receipt", session_id=session_id, admission_id=admission, include_result=True)

    async def history(self, limit: int) -> list[dict[str, Any]]:
        """The newest `limit` rows of the session as the gateway displays them. Raises Unavailable."""
        try:
            async with asyncio.timeout(self.history_timeout_s):
                session_id = await self.resolve()
                async with self.connect() as client:
                    canonical = await self._attach(client, session_id)
                    history = await client.rpc("session.history", session_id=canonical)
        except Unavailable:
            raise
        except Exception as e:  # the gateway's refusals and lost connections, and anything unforeseen
            log.warning("history unreadable", exc_info=not isinstance(e, self.lost | TimeoutError))
            raise Unavailable(f"history:{type(e).__name__}") from e
        messages = history.get("messages") if isinstance(history, dict) else None
        if not isinstance(messages, list):
            raise Unavailable("history:malformed")
        return [_row(message) for message in messages[-limit:] if isinstance(message, dict)]

    async def health(self) -> dict[str, Any]:
        """The session a consult would be a turn of, found and attached to. Raises Unavailable."""
        try:
            async with asyncio.timeout(self.history_timeout_s):
                session_id = await self.resolve()
                async with self.connect() as client:
                    return {"ready": True, "session_id": await self._attach(client, session_id)}
        except Unavailable:
            raise
        except Exception as e:  # the gateway's refusals and lost connections, and anything unforeseen
            log.warning("health check failed", exc_info=not isinstance(e, self.lost | TimeoutError))
            raise Unavailable(f"health:{type(e).__name__}") from e

    async def _attach(self, client: Client, session_id: str) -> str:
        try:
            return _string(await client.rpc("session.resume", session_id=session_id, omit_messages=True), "session_id")
        except Uncertain as e:
            raise Unavailable(str(e)) from e


async def _completion(client: Client, admission: str) -> None:
    """Consume event frames until `admission`'s message.complete; a lost connection raises _Lost.

    The admission ID is on the frame itself, stamped from the execution that
    published it (gateway/session_events.py publish), and on a cancelled
    admission's payload too (session_authority _settle_cancelled).
    """
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
    """The final text of a terminal receipt; Failed unless the turn completed with one."""
    outcome = receipt.get("outcome")
    if outcome != "completed":
        raise Failed(str(outcome))
    result = receipt.get("result")
    if not isinstance(result, dict):
        raise Failed("no_result")
    # gateway/session_results.py prepare_result: these flags make the outcome failed or interrupted.
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
    """A displayed row (tui_gateway/contracts/common.py TranscriptMessage), cut to what the broker reads."""
    text, timestamp = message.get("text"), message.get("timestamp")
    return {
        "role": message.get("role"),
        "text": text if isinstance(text, str) else None,
        "timestamp": timestamp if isinstance(timestamp, int | float) and not isinstance(timestamp, bool) else None,
    }


# Production: the pinned Hermes's own pieces.


@asynccontextmanager
async def gateway(home: Path) -> AsyncIterator[Any]:
    """An attachment to `home`'s running gateway; Unavailable unless one is ready.

    connect_gateway given an endpoint dials it as-is: it never starts a
    gateway, or replaces one, as its default would (hermes_cli/gateway_client.py).
    attachable is its own readiness rule: ready, or a restart's after-turn wait,
    whose owner still answers for its turns (a new submission there is refused).
    """
    from hermes_cli.gateway_client import connect_gateway
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint

    found = await asyncio.to_thread(discover_gateway_endpoint, home)
    if not attachable(found):
        raise Unavailable(f"gateway_{found.state}")
    # The default frame bound, as Hermes's CLI uses: the canonical session.resume answers with the
    # whole transcript, whatever omit_messages says (gateway/session_controls.py resume ignores it).
    async with connect_gateway(endpoint=found.endpoint) as client:
        yield client


def resolve_session(home: Path, route: str) -> str:
    """The active session of `route`, from `home`'s state.db, read-only; Unavailable when it has none.

    The gateway's own recovery lookup, so a /new reset fences off the session
    before it. No transcript is read, and no legacy sessions.json.
    """
    from hermes_state import SessionDB

    db = SessionDB(db_path=home / "state.db", read_only=True)
    try:
        # A route key is agent:<namespace>:<platform>:...; the row's source is the platform.
        row = db.find_latest_gateway_session_for_peer(source=route.split(":")[2], session_key=route)
    finally:
        db.close()
    session_id = row.get("id") if isinstance(row, dict) else None
    if not isinstance(session_id, str) or not session_id:
        raise Unavailable("no_session")
    return session_id


def telegram_route(chat_id_file: Path) -> str:
    """The route key of the owner's Telegram DM, whose chat ID the file holds.

    gateway/session.py build_session_key: agent:main (the default profile's
    namespace), the platform, the chat type, the chat ID.
    """
    chat_id = chat_id_file.read_text().strip()
    if not _CHAT_ID.fullmatch(chat_id):
        raise ValueError(f"{chat_id_file} holds no Telegram user's chat ID")
    return f"agent:main:telegram:dm:{chat_id}"


def make_app(bridge: Bridge) -> Any:
    """The bridge's aiohttp application."""
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
        # Honor the broker's configured row budget. The native gateway client
        # already bounds transcript frames; an unrelated row cap would reject
        # otherwise valid broker configurations before their own bounds apply.
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
    """`app` served on `socket`, mode 0660, and nowhere else; returns its runner, to clean up."""
    from aiohttp import web

    runner = web.AppRunner(app)
    await runner.setup()
    # A socket left by a bridge that died; anything else there is not ours to remove.
    if socket.is_socket():
        socket.unlink()
    # The socket is never more open than its final mode, not even between bind and chmod.
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
    # connect_gateway mints its ticket for get_hermes_home(), which reads HERMES_HOME.
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
