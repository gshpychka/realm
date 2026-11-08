"""The agent the broker delegates to is chosen by agent.provider, each with only its own options."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from voice_broker import config as config_module
from voice_broker.agent import create_agent
from voice_broker.config import Hermes, History, OpenClaw

HISTORY = {"max_messages": 40, "max_age_s": 3600, "max_chars": 8000}


def write_config(tmp_path: Path, agent: dict[str, Any]) -> Path:
    """A complete config file around `agent`, its secrets in files beside it."""
    for name in ("device-token", "openai-key", "ha-token"):
        (tmp_path / name).write_text("secret\n")
    raw = {
        "listen_host": "127.0.0.1",
        "listen_port": 0,
        "device_token_file": str(tmp_path / "device-token"),
        "openai_api_key_file": str(tmp_path / "openai-key"),
        "devices": [],
        "live": {"model": "gpt-live-1", "voice": "marin", "instructions": ""},
        "agent": agent,
        "calls": {
            "socket": str(tmp_path / "call.sock"),
            "home_assistant_url": "http://ha.test",
            "home_assistant_token_file": str(tmp_path / "ha-token"),
        },
        "idle_timeout_s": 1,
        "max_conversation_s": 30,
    }
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw))
    return path


def hermes(**overrides: Any) -> dict[str, Any]:
    return {
        "provider": "hermes",
        "socket": "/run/voice-broker-hermes/agent.sock",
        "instructions": "Answer briefly.",
        "history": HISTORY,
        **overrides,
    }


def openclaw(tmp_path: Path, **overrides: Any) -> dict[str, Any]:
    (tmp_path / "gateway-token").write_text("gateway-secret\n")
    return {
        "provider": "openclaw",
        "url": "http://openclaw.test",
        "token_file": str(tmp_path / "gateway-token"),
        "session_key": "agent:main:main",
        "instructions": "",
        "history": HISTORY,
        **overrides,
    }


def test_hermes_needs_no_openclaw_credentials(tmp_path: Path):
    config = config_module.load(write_config(tmp_path, hermes()))
    assert config.agent == Hermes(
        socket=Path("/run/voice-broker-hermes/agent.sock"),
        instructions="Answer briefly.",
        history=History(max_messages=40, max_age_s=3600.0, max_chars=8000),
    )


def test_openclaw_is_read_as_before(tmp_path: Path):
    config = config_module.load(write_config(tmp_path, openclaw(tmp_path, observer_session_key="agent:main:observer")))
    assert isinstance(config.agent, OpenClaw)
    assert config.agent.token == "gateway-secret"
    assert config.agent.session_key == "agent:main:main"
    assert config.agent.observer_session_key == "agent:main:observer"


@pytest.mark.parametrize("provider", [None, "", "OpenClaw", "hermes-agent"])
def test_an_unknown_or_missing_provider_is_refused(tmp_path: Path, provider: str | None):
    agent = hermes()
    if provider is None:
        del agent["provider"]
    else:
        agent["provider"] = provider
    with pytest.raises(ValueError, match="agent.provider"):
        config_module.load(write_config(tmp_path, agent))


@pytest.mark.parametrize(
    "key", ["url", "token_file", "session_key", "model", "overflow", "observer_session_key", "history_session_key"]
)
def test_hermes_refuses_openclaw_options(tmp_path: Path, key: str):
    with pytest.raises(ValueError, match=key):
        config_module.load(write_config(tmp_path, hermes(**{key: "x"})))


def test_hermes_needs_a_socket(tmp_path: Path):
    with pytest.raises(ValueError, match="socket"):
        config_module.load(write_config(tmp_path, hermes(socket="")))


def test_the_factory_builds_the_configured_agent(tmp_path: Path):
    async def build() -> None:
        agent = create_agent(config_module.load(write_config(tmp_path, hermes())).agent)
        try:
            # Hermes has no observer: Home Assistant's work goes unchecked.
            assert agent.observer is None
            assert type(agent).__module__ == "voice_broker.hermes"
        finally:
            await agent.aclose()

        agent = create_agent(config_module.load(write_config(tmp_path, openclaw(tmp_path))).agent)
        try:
            assert agent.observer is None
            assert type(agent).__module__ == "voice_broker.openclaw"
        finally:
            await agent.aclose()

        observed = openclaw(tmp_path, observer_session_key="agent:main:observer")
        agent = create_agent(config_module.load(write_config(tmp_path, observed)).agent)
        try:
            assert agent.observer is not None
        finally:
            await agent.aclose()

    asyncio.run(build())


def test_the_broker_runs_on_hermes(make_config, tmp_path: Path):
    from voice_broker.__main__ import Broker
    from voice_broker.config import Device

    agent = Hermes(socket=tmp_path / "agent.sock", instructions="", history=History(40, 3600.0, 8000))
    broker = Broker(make_config(agent=agent))
    device = Device(name="kitchen", address="10.0.0.5", area="Kitchen", call_action="esphome.kitchen_call")
    first, second = broker._consults(device), broker._consults(device)
    assert type(first).__module__ == "voice_broker.hermes"
    assert first._id != second._id and first._id.startswith("kitchen-")
    asyncio.run(broker._agent.aclose())
