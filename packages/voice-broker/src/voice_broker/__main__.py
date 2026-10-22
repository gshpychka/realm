"""Entry point: `voice-broker --config <file>`."""

from __future__ import annotations

import argparse
import asyncio
import hmac
import logging
import signal
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path

from openai import AsyncOpenAI
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from . import config as config_module
from ._aec import EchoCanceller
from .assist import HomeListener, ToolPolicy
from .calls import Calls
from .config import Config, Device
from .conversation import Conversation
from .home_assistant import HomeAssistant
from .live import LiveSession, Mode, Parallel, Routed, live_connector
from .openclaw import Conversation as Consults
from .openclaw import OpenClaw
from .protocol import MIC_RATE, ProtocolError, parse_start
from .routing import router

log = logging.getLogger("voice_broker")

# The device sends START right after connecting.
_START_TIMEOUT_S = 5

# The device a log record belongs to; every conversation task inherits it.
_device_name: ContextVar[str] = ContextVar("device", default="-")


class _DeviceFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.device = _device_name.get()
        return True


@dataclass
class _DeviceState:
    device: Device
    # Each room has its own echo path.
    aec: EchoCanceller
    # One conversation per device: a new wake word while one is running means
    # the old one is stale (e.g. the device rebooted mid-session).
    current: asyncio.Task[object] | None = None
    # Held by each Home Assistant run at this device, so the runs of a new
    # conversation wait for an old one's last to finish.
    home_runs: asyncio.Lock = field(default_factory=asyncio.Lock)


class Broker:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._openclaw = OpenClaw(config.openclaw)
        self._devices = {d.address: _DeviceState(d, EchoCanceller(MIC_RATE)) for d in config.devices}
        openai = AsyncOpenAI(api_key=config.openai_api_key)
        self._connect = live_connector(openai)
        # The one classifier, gating (routing) or only shadowing (parallel): config.load allows one mode.
        classifier = config.routing or (config.home_assistant.shadow if config.home_assistant else None)
        self._router = router(classifier, openai) if classifier else None
        self._calls = Calls(config.calls, config.devices, busy=self._in_conversation)

    def _mode(self, state: _DeviceState, opening: str | None) -> Mode:
        """How a conversation at the device answers delegations, as that device."""
        if self._config.routing is not None:
            # A call answers the agent, so the reply is the agent's whatever it says.
            return self._routed(state.device) if opening is None else None
        # In a call too: Home Assistant alone acts on the home, whoever opened the conversation.
        return self._parallel(state)

    def _routed(self, device: Device) -> Routed:
        """Gated routing for a conversation at `device`, with its own Home Assistant device."""
        routing = self._config.routing
        assert routing is not None and self._router is not None
        # config.load requires a device ID of every device while routing is on.
        assert device.home_assistant_device_id is not None
        home = HomeAssistant(
            self._config.calls.home_assistant_url,
            self._config.calls.home_assistant_token,
            routing.pipeline,
            device.home_assistant_device_id,
        )
        return Routed(self._router.route, home.converse, routing.pending_question_s, routing.settle_s)

    def _parallel(self, state: _DeviceState) -> Parallel | None:
        """Home Assistant listening to a conversation at the device, as that device."""
        home = self._config.home_assistant
        if home is None:
            return None
        # config.load requires a device ID of every device while Home Assistant listens.
        assert state.device.home_assistant_device_id is not None
        listener = HomeListener(
            self._config.calls.home_assistant_url,
            self._config.calls.home_assistant_token,
            home.pipeline,
            state.device.home_assistant_device_id,
            ToolPolicy(home.read_only_tools, home.non_home_tools),
            state.home_runs,
            barge_in=home.barge_in,
        )
        observe = self._openclaw.observe if self._config.openclaw.observer_session_key else None
        return Parallel(listener, observe, self._router.route if self._router else None)

    def _consults(self, device: Device) -> Consults:
        """A new conversation's consults at `device`, all in one session: main's, or its own when main's is too full.

        Its id is new for every conversation, so no two conversations, at one
        speaker or two, ever share an overflow session.
        """
        return self._openclaw.conversation(f"{device.name}-{uuid.uuid4().hex[:12]}")

    def _in_conversation(self, address: str) -> bool:
        current = self._devices[address].current
        return current is not None and not current.done()

    def _authorize(self, connection: ServerConnection, request: Request) -> Response | None:
        if connection.remote_address[0] not in self._devices:
            log.warning("rejected connection from unknown address %s", connection.remote_address)
            return connection.respond(HTTPStatus.FORBIDDEN, "unknown device\n")
        expected = f"Bearer {self._config.device_token}"
        given = request.headers.get("Authorization", "")
        if not hmac.compare_digest(given.encode(), expected.encode()):
            log.warning("rejected connection from %s", connection.remote_address)
            return connection.respond(HTTPStatus.UNAUTHORIZED, "unauthorized\n")
        return None

    async def _handle(self, device: ServerConnection) -> None:
        state = self._devices[device.remote_address[0]]
        _device_name.set(state.device.name)
        if state.current is not None and not state.current.done():
            log.info("new conversation replaces the running one")
            state.current.cancel()
        log.info("conversation from %s", device.remote_address)
        state.current = asyncio.current_task()
        try:
            start = parse_start(await asyncio.wait_for(device.recv(), _START_TIMEOUT_S))
        except (TimeoutError, ProtocolError, ConnectionClosed) as e:
            log.warning("no valid start from %s: %r", device.remote_address, e)
            return
        opening = self._calls.answer(device.remote_address[0])
        if opening is None:
            log.info("woken by %s", start.wake_word)
        else:
            log.info("answering a call")
        consults = self._consults(state.device)
        session = LiveSession(
            self._config.live,
            state.device.area,
            consults.consult,
            consults.recent,
            self._connect,
            opening,
            self._mode(state, opening),
        )
        reason = await Conversation(self._config, state.device.name, device, session, state.aec).run()
        log.info("conversation over: %s", reason)

    async def run(self) -> None:
        try:
            server: Server
            async with serve(
                self._handle,
                self._config.listen_host,
                self._config.listen_port,
                process_request=self._authorize,
                # Audio frames are small; this bounds what an unauthenticated
                # peer can make the broker buffer.
                max_size=64 * 1024,
                ping_interval=10,
                ping_timeout=10,
            ) as server:
                log.info("listening on %s:%d", self._config.listen_host, self._config.listen_port)
                if self._config.home_assistant is not None:
                    log.info(
                        "home assistant hears every utterance on pipeline %r", self._config.home_assistant.pipeline
                    )
                if self._router is not None:
                    role = "routing" if self._config.routing else "shadowing"
                    log.info("%s delegated requests with %s", role, self._router.label)
                calls = await self._calls.serve()
                stop = asyncio.Event()
                loop = asyncio.get_running_loop()
                for sig in (signal.SIGINT, signal.SIGTERM):
                    loop.add_signal_handler(sig, stop.set)
                await stop.wait()
                calls.close()
                server.close()
        finally:
            await self._openclaw.aclose()
            if self._router is not None:
                await self._router.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="voice-broker")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(level=args.log_level, format="%(levelname)s %(name)s [%(device)s]: %(message)s")
    for handler in logging.getLogger().handlers:
        handler.addFilter(_DeviceFilter())
    # The OpenAI SDK and httpx log every request at INFO.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(Broker(config_module.load(args.config)).run())


if __name__ == "__main__":
    main()
