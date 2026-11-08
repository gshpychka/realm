"""Backend configuration rejects unusable inputs without requiring another backend's credentials."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from voice_broker import config as config_module

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


def test_hermes_needs_no_openclaw_credentials(tmp_path: Path):
    # Loading must succeed when no OpenClaw token file exists.
    config_module.load(write_config(tmp_path, hermes()))


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
