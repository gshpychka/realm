"""Exercise the pinned acpx client with a local, credential-free ACP server.

This is a protocol fixture, not a model stub in production. Nix replaces only
the adapter executable in the real client wrapper for this build check.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

PROVIDER_KEYS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
)


def serve() -> None:
    log = Path(os.environ["HERMES_ACP_TEST_LOG"])
    lock = threading.Lock()
    pending = None
    session_id = "fixture-persistent-session"
    config_options = [
        {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "gpt-6.1-sol",
            "options": [{"value": "gpt-6.1-sol", "name": "GPT 6.1 Sol"}],
        },
        {
            "id": "reasoning_effort",
            "name": "Reasoning effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": "medium",
            "options": [
                {"value": "medium", "name": "Medium"},
                {"value": "xhigh", "name": "Extra high"},
            ],
        },
    ]

    def record(value):
        with log.open("a") as handle:
            handle.write(json.dumps(value) + "\n")

    def emit(value):
        with lock:
            print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)

    record(
        {"environment_present": {name: name in os.environ for name in PROVIDER_KEYS}}
    )
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        params = request.get("params", {})
        record({"method": method, "params": params})
        response = None
        if method == "initialize":
            response = {
                "protocolVersion": 1,
                "agentCapabilities": {"loadSession": True},
                "authMethods": [],
                "agentInfo": {"name": "realm-acp-fixture", "version": "1"},
            }
        elif method == "session/new":
            response = {"sessionId": session_id, "configOptions": config_options}
        elif method == "session/load":
            response = {"configOptions": config_options}
        elif method == "session/set_config_option":
            for option in config_options:
                if option["id"] == params["configId"]:
                    option["currentValue"] = params["value"]
            response = {"configOptions": config_options}
        elif method == "session/prompt":
            prompt = " ".join(part.get("text", "") for part in params.get("prompt", []))
            if prompt == "wait for cancellation":
                pending = request["id"]
                continue
            emit(
                {
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {
                                "type": "text",
                                "text": f"fixture reply: {prompt}",
                            },
                        },
                    },
                }
            )
            response = {"stopReason": "end_turn"}
        elif method == "session/cancel":
            if pending is not None:
                emit({"id": pending, "result": {"stopReason": "cancelled"}})
                pending = None
            response = {}
        if "id" in request:
            if response is None:
                emit(
                    {"id": request["id"], "error": {"code": -32601, "message": method}}
                )
            else:
                emit({"id": request["id"], "result": response})


def records(path: Path) -> list[dict]:
    return (
        [json.loads(line) for line in path.read_text().splitlines()]
        if path.exists()
        else []
    )


def check(client: Path, *, claude: bool) -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir()
        repository = root / "repository"
        repository.mkdir()
        log = root / "adapter.ndjson"
        adapter = root / ("claude-agent-acp" if claude else "codex-acp")
        adapter.write_text(f"#!{sys.executable}\n" + Path(__file__).read_text())
        adapter.chmod(0o700)
        env = {
            **os.environ,
            **dict.fromkeys(PROVIDER_KEYS, "fixture-inherited-credential"),
            "HOME": str(home),
            "HERMES_ACP_TEST_ADAPTER": str(adapter),
            "HERMES_ACP_TEST_LOG": str(log),
            "ACPX_CLAUDE_INCLUDE_USER_SETTINGS": "0",
        }
        base = [str(client), "--cwd", str(repository), "--ttl", "1"]

        def run(*arguments):
            result = subprocess.run(
                [*base, *arguments], capture_output=True, text=True, env=env, timeout=20
            )
            if result.returncode:
                raise AssertionError(
                    (arguments, result.returncode, result.stdout, result.stderr)
                )
            return result.stdout

        def prompted(text):
            return any(
                row.get("method") == "session/prompt"
                and any(
                    part.get("text") == text for part in row["params"].get("prompt", [])
                )
                for row in records(log)
            )

        if claude:
            run("sessions", "ensure", "--name", "review")
        else:
            run("--model", "gpt-6.1-sol", "sessions", "ensure", "--name", "review")
            run("set", "reasoning_effort", "xhigh", "-s", "review")
        shown = json.loads(run("sessions", "show", "review"))
        assert shown["name"] == "review", shown
        prompt_file = root / "prompt.txt"
        for prompt in ("first task", "resume the same task"):
            prompt_file.write_text(prompt)
            output = run("prompt", "-s", "review", "--file", str(prompt_file))
            assert f"fixture reply: {prompt}" in output, output
        history = run("sessions", "history", "review", "--limit", "20")
        assert "first task" in history and "resume the same task" in history, history
        run("status", "-s", "review")

        prompt_file.write_text("wait for cancellation")
        process = subprocess.Popen(
            [*base, "prompt", "-s", "review", "--file", str(prompt_file)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            deadline = time.monotonic() + 15
            while not prompted("wait for cancellation") and time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError(process.communicate())
                time.sleep(0.05)
            assert prompted("wait for cancellation"), records(log)
            run("cancel", "-s", "review")
            stdout, stderr = process.communicate(timeout=10)
            assert process.returncode in (0, 130), (process.returncode, stdout, stderr)
            assert "cancelled" in stdout, stdout
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            # Let the one-second queue owner TTL expire before retiring its
            # record. acpx correctly refuses to signal a PID when a build
            # sandbox cannot independently verify its process birth identity.
            time.sleep(1.5)
            run("sessions", "close", "review")

        rows = records(log)
        environments = [
            row["environment_present"] for row in rows if "environment_present" in row
        ]
        assert environments and all(not any(item.values()) for item in environments), (
            environments
        )
        assert any(row.get("method") == "session/load" for row in rows), rows
        assert any(row.get("method") == "session/cancel" for row in rows), rows
        if claude:
            sources = [
                row.get("params", {})
                .get("_meta", {})
                .get("claudeCode", {})
                .get("options", {})
                .get("settingSources")
                for row in rows
                if row.get("method") == "session/new"
            ]
            assert ["user", "project", "local"] in sources, sources
        else:
            assert any(
                row.get("method") == "session/set_config_option"
                and row.get("params", {}).get("configId") == "reasoning_effort"
                and row.get("params", {}).get("value") == "xhigh"
                for row in rows
            ), rows
        print(
            f"{'Claude' if claude else 'Codex'} ACP lifecycle and credential isolation passed"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", nargs=2, type=Path)
    arguments = parser.parse_args()
    if arguments.check:
        check(arguments.check[0], claude=True)
        check(arguments.check[1], claude=False)
    else:
        serve()
