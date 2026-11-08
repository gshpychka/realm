"""The Hermes bridge: one admission per submission ID, settled by its own durable receipt.

The gateway is scripted here: RPC answers and event frames shaped as the pinned
Hermes source sends them (gateway/session_controls.py, gateway/session_events.py).
"""

from __future__ import annotations

import asyncio
import shutil
import stat
import sys
import tempfile
import types
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from voice_broker import hermes_bridge
from voice_broker.hermes_bridge import Bridge, Failed, Unavailable, Uncertain

RESOLVED = "20261108_101500_abc"
CANONICAL = "20261101_090000_root"


class Refused(Exception):
    """The owner's refusal of one request (GatewayRPCError in production)."""


class Lost(Exception):
    """A lost connection (GatewayClientError in production)."""


class Client:
    def __init__(self, gateway: Gateway) -> None:
        self.gateway = gateway
        self.events: asyncio.Queue[Any] = asyncio.Queue()

    def emit(self, type_: str, admission_id: str | None, payload: dict[str, Any] | None = None) -> None:
        params: dict[str, Any] = {"type": type_, "session_id": CANONICAL, "payload": payload or {}}
        if admission_id is not None:
            params["admission_id"] = admission_id
        self.events.put_nowait({"jsonrpc": "2.0", "method": "event", "params": params})

    async def rpc(self, method: str, **params: Any) -> dict[str, Any]:
        gateway = self.gateway
        gateway.calls.append((method, params))
        if reason := gateway.refuse.get(method):
            raise Refused(reason)
        match method:
            case "session.resume":
                return {"session_id": CANONICAL, "stored_session_id": CANONICAL, "messages": [], "running": False}
            case "prompt.submit":
                admission = gateway.admissions.get(params["submission_id"])
                if admission is None:
                    admission = {
                        "admission_id": f"adm-{len(gateway.admissions) + 1}",
                        "status": "queued",
                        "outcome": None,
                        "params": params,
                    }
                    gateway.admissions[params["submission_id"]] = admission
                    if gateway.on_admit is not None:
                        gateway.on_admit(self, admission)
                if gateway.lose_submit_answers > 0:
                    gateway.lose_submit_answers -= 1
                    raise Lost("Gateway disconnected; turn outcome is unknown.")
                return gateway.receipt(admission)
            case "prompt.receipt":
                (admission,) = [a for a in gateway.admissions.values() if a["admission_id"] == params["admission_id"]]
                return gateway.receipt(admission, include_result=params.get("include_result") is True)
            case "session.history":
                return {"count": len(gateway.history), "messages": gateway.history}
            case _:
                raise AssertionError(f"unexpected {method}")


class Gateway:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.admissions: dict[str, dict[str, Any]] = {}
        self.refuse: dict[str, str] = {}
        self.history: list[dict[str, Any]] = []
        self.clients: list[Client] = []
        # Called once per new admission, with the client it was submitted on.
        self.on_admit: Callable[[Client, dict[str, Any]], None] | None = None
        self.lose_submit_answers = 0
        # Connections refused after the first this many.
        self.connections_left: int | None = None

    @asynccontextmanager
    async def connect(self):
        if self.connections_left is not None:
            if self.connections_left == 0:
                raise Lost("Gateway connection failed; no local fallback")
            self.connections_left -= 1
        client = Client(self)
        self.clients.append(client)
        yield client

    def receipt(self, admission: dict[str, Any], include_result: bool = False) -> dict[str, Any]:
        receipt = {
            "admission_id": admission["admission_id"],
            "ref": {"profile_id": "/var/lib/hermes/.hermes", "session_id": CANONICAL},
            "sequence": 1,
            "status": admission["status"],
            "outcome": admission["outcome"],
            "authority_epoch": 3,
            "execution_generation": 7,
        }
        if include_result and admission["status"] == "terminal" and "result" in admission:
            receipt["result"] = admission["result"]
            receipt["usage"] = {}
        return receipt

    def methods(self) -> list[str]:
        return [method for method, _ in self.calls]


def finish(admission: dict[str, Any], outcome: str = "completed", **result: Any) -> None:
    admission["status"] = "terminal"
    admission["outcome"] = outcome
    admission["result"] = {"final_response": "It is noon.", "messages": [], **result}


@pytest.fixture
def gateway() -> Iterator[Gateway]:
    gateway = Gateway()
    yield gateway
    # Whatever happened, the bridge never stops Hermes's work: not the turn, not the session's.
    assert not {"session.interrupt", "prompt.cancel", "session.detach"} & set(gateway.methods())


def bridge(gateway: Gateway, **overrides: Any) -> Bridge:
    async def resolve() -> str:
        return RESOLVED

    fields: dict[str, Any] = {
        "connect": gateway.connect,
        "resolve": resolve,
        "refused": Refused,
        "lost": Lost,
        "consult_timeout_s": 5.0,
        "tick_s": 10.0,
        "reconnect_s": 0.01,
    }
    fields.update(overrides)
    return Bridge(**fields)


def consult(b: Bridge, submission_id: str = "voice-broker:kitchen-1:1") -> str:
    return asyncio.run(b.consult(submission_id, "What time is it?", "Answer briefly."))


def submits(gateway: Gateway) -> list[dict[str, Any]]:
    return [params for method, params in gateway.calls if method == "prompt.submit"]


def test_a_consult_is_a_turn_of_the_resolved_session(gateway: Gateway):
    def complete(client: Client, admission: dict[str, Any]) -> None:
        async def later():
            admission["status"] = "started"
            # Commentary of this turn, and another turn of the session (Telegram's) ending: neither is the answer.
            client.emit("message.delta", admission["admission_id"], {"text": "Let me check"})
            client.emit("message.complete", "adm-telegram", {"text": "Telegram's answer", "status": "complete"})
            await asyncio.sleep(0.05)
            finish(admission)
            client.emit("message.complete", admission["admission_id"], {"text": "It is noon.", "status": "complete"})

        asyncio.get_running_loop().create_task(later())

    gateway.on_admit = complete
    assert consult(bridge(gateway)) == "It is noon."

    resume = gateway.calls[0]
    assert resume == ("session.resume", {"session_id": RESOLVED, "omit_messages": True})
    (submit,) = submits(gateway)
    # Exactly these: no voice_turn, no surface override, nothing that bypasses approvals.
    assert submit == {
        "session_id": CANONICAL,
        "submission_id": "voice-broker:kitchen-1:1",
        "text": "What time is it?",
        "api_text": "Answer briefly.\n\nWhat time is it?",
    }
    # Only the own completion led to a read of the receipt, the one with the result.
    receipts = [params for method, params in gateway.calls if method == "prompt.receipt"]
    assert receipts == [{"session_id": CANONICAL, "admission_id": "adm-1", "include_result": True}]


def test_a_lost_completion_frame_is_reconciled_from_the_receipt(gateway: Gateway):
    def complete_silently(client: Client, admission: dict[str, Any]) -> None:
        async def later():
            await asyncio.sleep(0.05)
            finish(admission)

        asyncio.get_running_loop().create_task(later())

    gateway.on_admit = complete_silently
    assert consult(bridge(gateway, tick_s=0.02)) == "It is noon."
    assert len(submits(gateway)) == 1


def test_an_already_settled_submission_is_answered_from_its_receipt(gateway: Gateway):
    admission = {"admission_id": "adm-earlier", "status": "queued", "outcome": None}
    finish(admission, final_response="Earlier answer.")
    gateway.admissions["voice-broker:kitchen-1:1"] = admission
    assert consult(bridge(gateway)) == "Earlier answer."
    assert len(submits(gateway)) == 1


@pytest.mark.parametrize(
    "outcome, result, code",
    [
        ("interrupted", {"interrupted": True}, "interrupted"),
        ("failed", {"failed": True, "error": "provider down"}, "failed"),
        ("cancelled", None, "cancelled"),
        ("steered", {}, "steered"),
        ("completed", {"final_response": "   "}, "empty"),
        ("completed", {"final_response": None}, "empty"),
        ("completed", {"error": "x"}, "failed"),
        ("completed", None, "no_result"),
    ],
)
def test_a_turn_ending_without_an_answer_fails(gateway: Gateway, outcome: str, result: dict | None, code: str):
    def settle(client: Client, admission: dict[str, Any]) -> None:
        admission["status"] = "terminal"
        admission["outcome"] = outcome
        if result is not None:
            admission["result"] = {"final_response": "partial", "messages": [], **result}

    gateway.on_admit = settle
    with pytest.raises(Failed, match=code):
        consult(bridge(gateway))


def test_an_unknown_outcome_is_uncertain(gateway: Gateway):
    def lose(client: Client, admission: dict[str, Any]) -> None:
        admission["status"] = "unknown"

    gateway.on_admit = lose
    with pytest.raises(Uncertain):
        consult(bridge(gateway))


def test_a_lost_submit_answer_recovers_the_same_submission(gateway: Gateway):
    def complete(client: Client, admission: dict[str, Any]) -> None:
        finish(admission)

    gateway.on_admit = complete
    gateway.lose_submit_answers = 1
    assert consult(bridge(gateway)) == "It is noon."
    # The exact submission again, which the gateway answers with the admission it already has.
    first, again = submits(gateway)
    assert first == again
    assert len(gateway.admissions) == 1
    assert len(gateway.clients) == 2


def test_a_disconnect_while_waiting_reads_the_receipt_again(gateway: Gateway):
    def drop(client: Client, admission: dict[str, Any]) -> None:
        admission["status"] = "started"

        async def later():
            await asyncio.sleep(0.02)
            finish(admission)
            # GatewayClient queues its disconnect error as an event.
            client.events.put_nowait(Lost("Gateway disconnected; turn outcome is unknown."))

        asyncio.get_running_loop().create_task(later())

    gateway.on_admit = drop
    assert consult(bridge(gateway)) == "It is noon."
    assert len(submits(gateway)) == 1
    assert len(gateway.clients) == 2
    assert gateway.calls[-1] == (
        "prompt.receipt",
        {"session_id": CANONICAL, "admission_id": "adm-1", "include_result": True},
    )


def test_an_unprovable_completion_is_uncertain(gateway: Gateway):
    def start(client: Client, admission: dict[str, Any]) -> None:
        admission["status"] = "started"
        client.events.put_nowait(Lost("Gateway disconnected; turn outcome is unknown."))

    gateway.on_admit = start
    gateway.connections_left = 1
    with pytest.raises(Uncertain):
        consult(bridge(gateway, consult_timeout_s=0.3))
    assert len(submits(gateway)) == 1


def test_a_turn_running_past_the_bound_is_uncertain(gateway: Gateway):
    gateway.on_admit = lambda client, admission: admission.update(status="started")
    with pytest.raises(Uncertain):
        consult(bridge(gateway, consult_timeout_s=0.1, tick_s=0.02))
    assert len(submits(gateway)) == 1


def test_a_cancelled_consult_leaves_the_turn_running(gateway: Gateway):
    gateway.on_admit = lambda client, admission: admission.update(status="started")

    async def scenario():
        task = asyncio.create_task(bridge(gateway).consult("voice-broker:kitchen-1:1", "Run long.", ""))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    # The fixture checks that nothing was interrupted or cancelled; the admission is still the gateway's.
    assert gateway.admissions["voice-broker:kitchen-1:1"]["status"] == "started"


def test_a_refused_submission_submitted_nothing(gateway: Gateway):
    gateway.refuse["prompt.submit"] = "runtime_draining"
    with pytest.raises(Unavailable, match="runtime_draining"):
        consult(bridge(gateway))


def test_no_gateway_submits_nothing(gateway: Gateway):
    gateway.connections_left = 0
    with pytest.raises(Unavailable):
        consult(bridge(gateway))
    assert submits(gateway) == []


def test_no_active_session_submits_nothing(gateway: Gateway):
    async def missing() -> str:
        raise Unavailable("no_session")

    with pytest.raises(Unavailable, match="no_session"):
        consult(bridge(gateway, resolve=missing))
    assert gateway.calls == []


def test_history_is_the_canonical_sessions_newest(gateway: Gateway):
    gateway.history = [
        {"role": "user", "text": "first", "timestamp": 1.0, "row_id": 1},
        {"role": "tool", "content": "{}", "name": "terminal", "timestamp": 2.0},
        {"role": "assistant", "text": "second", "timestamp": 3.5, "reasoning": "private"},
        {"role": "user", "text": "third"},
    ]
    messages = asyncio.run(bridge(gateway).history(limit=3))
    assert messages == [
        {"role": "tool", "text": None, "timestamp": 2.0},
        {"role": "assistant", "text": "second", "timestamp": 3.5},
        {"role": "user", "text": "third", "timestamp": None},
    ]
    assert gateway.calls == [
        ("session.resume", {"session_id": RESOLVED, "omit_messages": True}),
        ("session.history", {"session_id": CANONICAL}),
    ]


def test_unreadable_history_is_unavailable(gateway: Gateway):
    gateway.refuse["session.history"] = "not_found"
    with pytest.raises(Unavailable):
        asyncio.run(bridge(gateway).history(limit=3))


def test_health_names_the_canonical_session_only(gateway: Gateway):
    assert asyncio.run(bridge(gateway).health()) == {"ready": True, "session_id": CANONICAL}
    assert gateway.methods() == ["session.resume"]


# The production pieces, on stand-ins of the pinned Hermes modules they import.


class SessionDB:
    opened: list[dict[str, Any]] = []
    closed = 0
    row: dict[str, Any] | None = {"id": RESOLVED, "session_key": "agent:main:telegram:dm:42"}
    lookups: list[dict[str, Any]] = []

    def __init__(self, db_path: Path, read_only: bool = False) -> None:
        SessionDB.opened.append({"db_path": db_path, "read_only": read_only})

    def find_latest_gateway_session_for_peer(self, **query: Any) -> dict[str, Any] | None:
        SessionDB.lookups.append(query)
        if SessionDB.row == "boom":
            raise RuntimeError("database is locked")
        return SessionDB.row

    def close(self) -> None:
        SessionDB.closed += 1


@pytest.fixture
def hermes_state(monkeypatch: pytest.MonkeyPatch) -> type[SessionDB]:
    SessionDB.opened, SessionDB.lookups, SessionDB.closed = [], [], 0
    monkeypatch.setitem(sys.modules, "hermes_state", types.SimpleNamespace(SessionDB=SessionDB))
    return SessionDB


def test_the_session_is_resolved_read_only_by_route(hermes_state: type[SessionDB], monkeypatch: pytest.MonkeyPatch):
    home = Path("/var/lib/hermes/.hermes")
    assert hermes_bridge.resolve_session(home, "agent:main:telegram:dm:42") == RESOLVED
    assert hermes_state.opened == [{"db_path": home / "state.db", "read_only": True}]
    assert hermes_state.lookups == [{"source": "telegram", "session_key": "agent:main:telegram:dm:42"}]
    assert hermes_state.closed == 1

    monkeypatch.setattr(SessionDB, "row", None)
    with pytest.raises(Unavailable, match="no_session"):
        hermes_bridge.resolve_session(home, "agent:main:telegram:dm:42")
    assert hermes_state.closed == 2

    monkeypatch.setattr(SessionDB, "row", "boom")
    with pytest.raises(RuntimeError):
        hermes_bridge.resolve_session(home, "agent:main:telegram:dm:42")
    assert hermes_state.closed == 3


def gateway_modules(monkeypatch: pytest.MonkeyPatch, discovery: Any, dialed: list[Any]) -> None:
    def discover_gateway_endpoint(home: Path):
        return discovery

    def attachable(result: Any) -> bool:
        return result.endpoint is not None and result.state == "ready"

    @asynccontextmanager
    async def connect_gateway(endpoint=None):
        dialed.append(endpoint)
        yield "client"

    runtime = types.SimpleNamespace(discover_gateway_endpoint=discover_gateway_endpoint, attachable=attachable)
    client = types.SimpleNamespace(connect_gateway=connect_gateway)
    monkeypatch.setitem(
        sys.modules, "hermes_cli", types.SimpleNamespace(gateway_runtime=runtime, gateway_client=client)
    )
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_runtime", runtime)
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", client)


def test_the_gateway_is_dialed_only_when_discovered_ready(monkeypatch: pytest.MonkeyPatch):
    dialed: list[Any] = []
    home = Path("/var/lib/hermes/.hermes")

    async def attach() -> Any:
        async with hermes_bridge.gateway(home) as client:
            return client

    gateway_modules(monkeypatch, types.SimpleNamespace(state="starting", endpoint=None), dialed)
    with pytest.raises(Unavailable, match="gateway_starting"):
        asyncio.run(attach())
    assert dialed == []

    gateway_modules(monkeypatch, types.SimpleNamespace(state="ready", endpoint="endpoint"), dialed)
    assert asyncio.run(attach()) == "client"
    # The discovered endpoint, dialed as-is: connect_gateway starts or replaces nothing then.
    assert dialed == ["endpoint"]


def test_invalid_owner_ids_are_refused(tmp_path: Path):
    chat = tmp_path / "chat-id"
    for bad in ("", "abc", "-100123", "12 34"):
        chat.write_text(bad)
        with pytest.raises(ValueError):
            hermes_bridge.telegram_route(chat)
    with pytest.raises(OSError):
        hermes_bridge.telegram_route(tmp_path / "missing")


# The HTTP side, on a real Unix socket.


@pytest.fixture
def socket() -> Iterator[Path]:
    directory = Path(tempfile.mkdtemp(prefix="vb"))
    yield directory / "agent.sock"
    shutil.rmtree(directory)


def served(gateway: Gateway, socket: Path, requests: Callable[[Any], Any], **overrides: Any) -> Any:
    """Runs `requests(client)` against the bridge served on `socket`."""
    pytest.importorskip("aiohttp")
    import httpx2

    async def scenario():
        runner = await hermes_bridge.serve(hermes_bridge.make_app(bridge(gateway, **overrides)), socket)
        try:
            async with httpx2.AsyncClient(
                transport=httpx2.AsyncHTTPTransport(uds=str(socket)), base_url="http://hermes"
            ) as client:
                return await requests(client)
        finally:
            await runner.cleanup()

    return asyncio.run(scenario())


def test_the_bridge_answers_over_its_socket(gateway: Gateway, socket: Path):
    gateway.on_admit = lambda client, admission: finish(admission)
    gateway.history = [{"role": "user", "text": "hi", "timestamp": 1.0}]

    async def requests(client):
        mode = stat.S_IMODE(socket.stat().st_mode)
        consult = await client.post(
            "/consult",
            json={"submission_id": "voice-broker:k:1", "task": "What time is it?", "instructions": "Be brief."},
        )
        history = await client.get("/history", params={"limit": 5})
        health = await client.get("/health")
        return mode, consult, history, health

    mode, consult, history, health = served(gateway, socket, requests)
    assert mode == 0o660
    assert (consult.status_code, consult.json()) == (200, {"text": "It is noon."})
    assert (history.status_code, history.json()) == (
        200,
        {"messages": [{"role": "user", "text": "hi", "timestamp": 1.0}]},
    )
    assert (health.status_code, health.json()) == (200, {"ready": True, "session_id": CANONICAL})


@pytest.mark.parametrize(
    "setup, status, error",
    [
        (lambda g: g.refuse.update({"prompt.submit": "runtime_draining"}), 503, "runtime_draining"),
        (lambda g: setattr(g, "on_admit", lambda c, a: finish(a, "interrupted", interrupted=True)), 502, "interrupted"),
        (lambda g: setattr(g, "on_admit", lambda c, a: a.update(status="unknown")), 504, "uncertain"),
    ],
)
def test_consult_errors_say_whether_anything_ran(gateway: Gateway, socket: Path, setup, status: int, error: str):
    setup(gateway)

    async def requests(client):
        return await client.post(
            "/consult", json={"submission_id": "voice-broker:k:1", "task": "t", "instructions": ""}
        )

    response = served(gateway, socket, requests)
    assert response.status_code == status
    assert error in response.json()["error"]


@pytest.mark.parametrize(
    "body",
    [
        {"task": "t", "instructions": ""},
        {"submission_id": "", "task": "t", "instructions": ""},
        {"submission_id": "has space", "task": "t", "instructions": ""},
        {"submission_id": "x" * 201, "task": "t", "instructions": ""},
        {"submission_id": "s", "task": "", "instructions": ""},
        {"submission_id": "s", "task": "t", "instructions": 3},
        {"submission_id": "s", "task": "t", "instructions": "", "voice_turn": True},
        ["s", "t"],
    ],
)
def test_malformed_consults_are_refused_before_the_gateway(gateway: Gateway, socket: Path, body: Any):
    async def requests(client):
        return await client.post("/consult", json=body)

    assert served(gateway, socket, requests).status_code == 400
    assert gateway.calls == []


def test_history_accepts_the_deployed_300_row_budget(gateway: Gateway, socket: Path):
    gateway.history = [{"role": "user", "text": f"row {index}", "timestamp": 1.0} for index in range(350)]

    async def requests(client):
        return await client.get("/history", params={"limit": 300})

    response = served(gateway, socket, requests)
    assert response.status_code == 200
    assert response.json()["messages"] == gateway.history[-300:]


def test_the_bridge_bounds_requests_and_routes(gateway: Gateway, socket: Path):
    async def requests(client):
        return (
            await client.post("/consult", content=b"{" + b" " * (300 * 1024) + b"}"),
            await client.get("/consult"),
            await client.post("/history"),
            await client.get("/nothing"),
            await client.get("/history", params={"limit": "0"}),
            await client.get("/history", params={"limit": "not-an-integer"}),
            await client.get("/history"),
        )

    statuses = [r.status_code for r in served(gateway, socket, requests)]
    assert statuses == [413, 405, 405, 404, 400, 400, 400]
    assert gateway.calls == []
