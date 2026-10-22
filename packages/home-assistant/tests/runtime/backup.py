"""Exercise real archive copies; only systemctl is replaced with a recorder."""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace


def fixture(root):
    for name in (
        "hass",
        "matter-server",
        "mosquitto",
        "private/home-assistant",
        "private/ha-mcp",
        "tailscale",
        "bluetooth",
    ):
        (root / "var/lib" / name).mkdir(parents=True, exist_ok=True)
    # systemd DynamicUser exposes this public symlink to its private directory.
    (root / "var/lib/ha-mcp").symlink_to("private/ha-mcp", target_is_directory=True)
    (root / "var/lib/private/ha-mcp/server-state").write_text("synthetic MCP state")
    (root / "run/home-assistant-backup").mkdir(parents=True)
    (root / "etc/ssh").mkdir(parents=True)
    (root / "etc/ssh/ssh_host_ed25519_key").write_text("synthetic host key")
    current = root / "var/lib/home-assistant-backup"
    current.mkdir()
    (current / "previous-snapshot").touch()
    state = root / "var/lib/hass/state"
    state.write_text("synthetic HA state")
    state.chmod(0o640)
    # Where available, use a supplementary group different from the job's group.
    # This catches copytree/copy2's ownership loss without requiring root.
    groups = [group for group in os.getgroups() if group != os.getegid()]
    if groups:
        try:
            os.chown(state, os.geteuid(), groups[0])
        except OSError as error:
            # Sandboxed user namespaces may expose an unmapped host group.
            if error.errno not in (1, 22):
                raise
    (root / "var/lib/hass/secrets.yaml").symlink_to("/run/credentials/fixture")
    for name in ("home-assistant_v2.db", "zigbee.db"):
        with sqlite3.connect(root / "var/lib/hass" / name) as connection:
            connection.execute("CREATE TABLE fixture (id INTEGER)")


def run(host, module):
    source = host / "runtime/backup/consistent-backup.py"
    active = ("home-assistant", "mosquitto", "bluetooth")
    stopping = ("systemctl", "stop", *active)
    starting = ("systemctl", "start", *reversed(active))
    for failure in (None, "corrupt", "missing", "staging", "stop", "copy", "start"):
        backup = module("backup", source)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture(root)
            current = root / "var/lib/home-assistant-backup"
            staging = root / "var/lib/home-assistant-backup.next"
            journal = root / "run/home-assistant-backup/active-services.json"
            if failure == "corrupt":
                (root / "var/lib/hass/zigbee.db").write_bytes(b"invalid fixture")
            elif failure == "missing":
                (root / "var/lib/bluetooth").rmdir()
            elif failure == "staging":
                staging.mkdir()
            operations = []
            execute = backup.command
            injected = [failure]

            def command(
                *args,
                operations=operations,
                execute=execute,
                injected=injected,
                **kwargs,
            ):
                operations.append(args)
                if (
                    (injected[0] == "stop" and args == stopping)
                    or (injected[0] == "start" and args == starting)
                    or (injected[0] == "copy" and args[0] == "cp")
                ):
                    raise subprocess.CalledProcessError(1, args)
                if args[0] == "cp":
                    return execute(*args, **kwargs)
                return SimpleNamespace(
                    returncode=0 if "is-active" not in args or args[-1] in active else 3
                )

            backup.Path = lambda path, root=root: root / str(path).lstrip("/")
            backup.command = command
            failed = False
            try:
                backup.main()
            except (RuntimeError, sqlite3.DatabaseError, subprocess.CalledProcessError):
                failed = True
            assert failed == (failure is not None), failure
            before_stop = failure in ("missing", "staging")
            assert (stopping in operations) != before_stop, failure
            assert (starting in operations) != before_stop, failure
            assert journal.exists() == (failure == "start"), failure
            published = failure in (None, "start")
            assert (current / "previous-snapshot").exists() != published, failure
            assert (current / ".consistent-snapshot").exists() == published, failure
            if published:
                key = current / "ssh-host-keys/ssh_host_ed25519_key"
                assert key.read_text() == "synthetic host key"
                assert key.stat().st_mode & 0o777 == 0o600
                source_state = root / "var/lib/hass/state"
                destination = current / "hass/state"
                for field in ("st_uid", "st_gid", "st_mode", "st_mtime_ns"):
                    assert getattr(destination.stat(), field) == getattr(
                        source_state.stat(), field
                    )
                assert (current / "hass/secrets.yaml").readlink() == Path(
                    "/run/credentials/fixture"
                )
                assert not (current / "ha-mcp").is_symlink()
                assert (
                    current / "ha-mcp/server-state"
                ).read_text() == "synthetic MCP state"
            if failure == "start":
                # A failed service restart remains retryable through ExecStopPost.
                injected[0] = None
                backup.main(recover=True)
                assert not journal.exists()
            operations.clear()
            backup.main(recover=True)
            assert not operations  # Successful cleanup is idempotent.

    # Kill the actual preparation process during a copy. Its finally cannot run;
    # emulate systemd's independent cleanup hook against the surviving journal.
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        fixture(root)
        script = r"""
import importlib.util
import signal
import sys
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("backup", sys.argv[1])
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
root = Path(sys.argv[2])
backup.Path = lambda path: root / str(path).lstrip("/")
def command(*args, **_kwargs):
    if args[0] == "cp":
        (root / "copy-entered").touch()
        signal.pause()
    return SimpleNamespace(returncode=0)
backup.command = command
backup.main()
"""
        process = subprocess.Popen(
            [sys.executable, "-c", script, str(source), str(root)]
        )
        try:
            deadline = time.monotonic() + 10
            while not (root / "copy-entered").exists():
                assert process.poll() is None, "fixture backup exited before copying"
                assert time.monotonic() < deadline, (
                    "fixture backup did not begin copying"
                )
                time.sleep(0.01)
            process.kill()
            process.wait(timeout=10)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
        journal = root / "run/home-assistant-backup/active-services.json"
        assert json.loads(journal.read_text()) == list(backup.SERVICES)
        backup = module("backup", source)
        operations = []
        backup.Path = lambda path: root / str(path).lstrip("/")
        backup.command = lambda *args, **_kwargs: operations.append(args)
        backup.main(recover=True)
        assert operations == [("systemctl", "start", *reversed(backup.SERVICES))]
        assert not journal.exists()
        assert (root / "var/lib/home-assistant-backup/previous-snapshot").exists()
        assert (root / "var/lib/home-assistant-backup.next").exists()
