from __future__ import annotations

from pathlib import Path

import pytest
from voice_broker.config import Calls, Config, History, Live, OpenClaw


@pytest.fixture
def make_config(tmp_path: Path):
    """A complete Config of placeholder values, with keyword overrides for the fields a test is about."""

    def make(**overrides) -> Config:
        fields = {
            "listen_host": "127.0.0.1",
            "listen_port": 0,
            "device_token": "token",
            "openai_api_key": "key",
            "devices": [],
            "live": Live(model="gpt-live-1", voice="marin", instructions=""),
            "openclaw": OpenClaw(
                url="http://openclaw.test",
                token="gateway-secret",
                session_key="agent:main:main",
                instructions="",
                model=None,
                history=History(max_messages=40, max_age_s=3600, max_chars=8000),
            ),
            "calls": Calls(
                socket=tmp_path / "call.sock", home_assistant_url="http://ha.test", home_assistant_token="ha-token"
            ),
            "idle_timeout_s": 1.0,
            "max_conversation_s": 30.0,
            "recordings_dir": None,
        }
        fields.update(overrides)
        return Config(**fields)

    return make
