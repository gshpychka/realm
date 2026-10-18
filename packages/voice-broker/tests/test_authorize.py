"""Only a configured speaker presenting the device token opens a conversation."""

from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace

from voice_broker.__main__ import Broker
from voice_broker.config import Calls, Config, Device, History, Live, OpenClaw

SPEAKER = "10.0.0.5"


def test_only_a_known_speaker_with_the_token_is_let_in(tmp_path: Path):
    config = Config(
        listen_host="127.0.0.1",
        listen_port=0,
        device_token="device-token",
        openai_api_key="key",
        devices=[Device(name="kitchen", address=SPEAKER, area="Kitchen", call_action="esphome.kitchen_call")],
        live=Live(model="gpt-live-1", voice="marin", instructions=""),
        openclaw=OpenClaw(
            url="http://openclaw.test",
            token="gateway-token",
            session_key="agent:main:main",
            instructions="",
            model=None,
            history=History(max_messages=40, max_age_s=3600, max_chars=8000),
        ),
        calls=Calls(socket=tmp_path / "call.sock", home_assistant_url="http://ha.test", home_assistant_token="t"),
        idle_timeout_s=1.0,
        max_conversation_s=30.0,
        recordings_dir=None,
    )
    broker = Broker(config)

    def answer(address: str, authorization: str | None) -> HTTPStatus | None:
        connection = SimpleNamespace(remote_address=(address, 40000), respond=lambda status, body: status)
        headers = {} if authorization is None else {"Authorization": authorization}
        return broker._authorize(connection, SimpleNamespace(headers=headers))

    assert answer(SPEAKER, "Bearer device-token") is None
    assert answer(SPEAKER, "Bearer another-token") == HTTPStatus.UNAUTHORIZED
    assert answer(SPEAKER, None) == HTTPStatus.UNAUTHORIZED
    assert answer("10.0.0.9", "Bearer device-token") == HTTPStatus.FORBIDDEN
