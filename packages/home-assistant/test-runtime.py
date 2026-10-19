"""Offline contracts for cooling, consistent backups and the Yasno app.

All filesystem writes use temporary directories; systemctl and I2C are stubs.
"""

import asyncio
import importlib.util
import math
import sqlite3
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def cooling(host):
    fan = module("argonone", host / "argonone.py")
    assert [fan.fan_speed(value) for value in [40, 55, 55.9, 60, 74, 75, 90]] == [
        0,
        0,
        0,
        25,
        95,
        100,
        100,
    ]
    for value in [math.nan, math.inf, -30, 160]:
        try:
            fan.fan_speed(value)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid temperature accepted")
    writes = []
    fan.write_speed(
        SimpleNamespace(write_byte_data=lambda *args: writes.append(args)), 65
    )
    assert writes == [(0x1A, 0x80, 65)]
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        thermal = root / "sys/class/thermal/thermal_zone0/temp"
        thermal.parent.mkdir(parents=True)
        thermal.write_text("60000")
        status = root / "run/argonone/fan-status"
        status.parent.mkdir(parents=True)
        writes = []

        class Bus:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def write_byte_data(self, *args):
                writes.append(args)

        def read_then_stop(_seconds):
            assert list(map(float, status.read_text().split())) == [25, 60]
            raise SystemExit(0)

        with (
            patch.dict(sys.modules, {"smbus2": SimpleNamespace(SMBus=lambda _: Bus())}),
            patch.object(fan, "Path", lambda path: root / str(path).lstrip("/")),
            patch.object(fan.time, "sleep", read_then_stop),
            patch.object(fan.signal, "signal"),
        ):
            try:
                fan.main()
            except SystemExit as result:
                assert result.code == 0
        assert writes == [(0x1A, 0x80, 100), (0x1A, 0x80, 25), (0x1A, 0x80, 100)]
        assert not status.exists()


def backups(host):
    for corrupt in [False, True]:
        backup = module("backup", host / "consistent-backup.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in [
                "hass",
                "matter-server",
                "mosquitto",
                "private/home-assistant",
                "ha-mcp",
                "tailscale",
                "bluetooth",
            ]:
                (root / "var/lib" / name).mkdir(parents=True, exist_ok=True)
            (root / "run/lock").mkdir(parents=True)
            (root / "etc/ssh").mkdir(parents=True)
            (root / "etc/ssh/ssh_host_ed25519_key").write_text("synthetic fixture")
            current = root / "var/lib/home-assistant-backup"
            current.mkdir()
            (current / "previous-snapshot").touch()
            for name in ["home-assistant_v2.db", "zigbee.db"]:
                with sqlite3.connect(root / "var/lib/hass" / name) as connection:
                    connection.execute("CREATE TABLE fixture (id INTEGER)")
            if corrupt:
                (root / "var/lib/hass/zigbee.db").write_bytes(b"invalid fixture")
            operations = []

            def command(*args, operations=operations, **_kwargs):
                operations.append(args)
                active = args[-1] in {"home-assistant", "mosquitto", "bluetooth"}
                return SimpleNamespace(
                    returncode=0 if "is-active" not in args or active else 3
                )

            backup.Path = lambda path, root=root: root / str(path).lstrip("/")
            backup.command = command
            failed = False
            try:
                backup.main()
            except sqlite3.DatabaseError:
                failed = True
            assert failed == corrupt
            assert (
                "systemctl",
                "stop",
                "home-assistant",
                "mosquitto",
                "bluetooth",
            ) in operations
            assert operations[-1] == (
                "systemctl",
                "start",
                "bluetooth",
                "mosquitto",
                "home-assistant",
            )
            assert (current / "previous-snapshot").exists() == corrupt
            assert (current / ".consistent-snapshot").exists() != corrupt
            if not corrupt:
                key = current / "ssh-host-keys/ssh_host_ed25519_key"
                assert key.read_text() == "synthetic fixture"
                assert key.stat().st_mode & 0o777 == 0o600
                assert (current / "bluetooth").is_dir()


def guard(host):
    directory = host / "yasno-address-guard"
    flow = module("flow", directory / "flow_contract.py")
    settings = {
        "region": "fixture",
        "provider": "fixture",
        "scan_interval": 15,
        "filter_probable": True,
        "status_all_day_events": True,
    }
    assert (
        flow.next_input(
            {"type": "abort", "reason": "reconfigure_successful"}, {}, "1.1"
        )
        is None
    )
    for response in [
        {"type": "abort", "reason": "unknown"},
        {"type": "form", "step_id": "unexpected"},
        {"errors": {"base": "changed"}},
    ]:
        try:
            flow.next_input(response, settings, "1.1")
        except flow.IncompatibleFlow:
            pass
        else:
            raise AssertionError("incompatible flow accepted")
    slots = module("slots", directory / "validation.py")
    slots.validate_slots([{"type": "Definite", "start": 0, "end": 1440}])
    for value in [
        [{"type": "Definite", "start": True, "end": 10}],
        [
            {"type": "Definite", "start": 0, "end": 50},
            {"type": "Definite", "start": 40, "end": 60},
        ],
    ]:
        try:
            slots.validate_slots(value)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid or overlapping schedule accepted")
    engine = module("engine", directory / "engine.py")

    async def recovery():
        journal = {"pending": {"previous_group": "1.1", "new_group": "2.2"}}
        saved = []
        instance = engine.Guard(
            None, {}, journal, lambda value: saved.append(dict(value))
        )
        assert await instance.check(dry_run=True) == {
            "status": "repair_pending",
            "writes": 0,
        }
        assert not saved
        operations = []

        async def record(group):
            operations.append(group)

        instance.reconfigure = instance.loaded = instance.handover = record
        await instance.rollback()
        assert operations == ["1.1", "1.1", "1.1"]
        assert journal == {"last_valid_group": "1.1"}
        assert len(saved) == 1

        # Provider and notification failures must still produce a durable retry
        # status instead of losing the original error in the notification call.
        async def unavailable(*_args):
            raise RuntimeError("synthetic provider/notification failure")

        instance.group = unavailable
        instance.api = SimpleNamespace(notification=unavailable)
        result = await instance.check()
        assert result["status"] == "check_failed"
        assert journal["notification_failed"] is True
        assert saved[-1]["notification_failed"] is True
        assert result["notification_failed"] is True
        assert journal["error"] == "official_lookup_validation_or_correction_failed"
        assert result["next_check"] == saved[-1]["next_check"] == journal["next_check"]
        assert saved[-1]["error"] == journal["error"]

        # Reloaded journals must expose the failure while waiting for the retry.
        reloaded = dict(saved[-1])
        instance = engine.Guard(
            SimpleNamespace(notification=unavailable),
            {},
            reloaded,
            lambda value: saved.append(dict(value)),
        )
        result = await instance.check()
        assert result["status"] == "not_due"
        assert result["notification_failed"] is True

        # Successful notification delivery clears a previous delivery failure,
        # even if provider validation still fails and schedules another retry.
        async def delivered(_message):
            pass

        instance.group = unavailable
        instance.api.notification = delivered
        result = await instance.check(force_check=True)
        assert result["status"] == "check_failed"
        assert result["notification_failed"] is False
        assert saved[-1]["notification_failed"] is False
        assert saved[-1]["error"] == "official_lookup_validation_or_correction_failed"

        # Verification also clears a persisted delivery failure without sending
        # an unnecessary notification.
        instance.api.notification = unavailable
        result = await instance.check(force_check=True)
        assert result["notification_failed"] is True
        assert saved[-1]["notification_failed"] is True

        async def unchanged():
            return "1.1"

        instance.group = instance.candidate = unchanged
        result = await instance.check(force_check=True)
        assert result["status"] == "verified"
        assert result["notification_failed"] is False
        assert saved[-1]["notification_failed"] is False
        assert saved[-1]["error"] is None
        assert result["next_check"] == saved[-1]["next_check"]

        # Failed rollback notifications use the same durable status contract.
        reloaded["pending"] = {"previous_group": "1.1", "new_group": "2.2"}
        instance.rollback = unavailable
        result = await instance.check(force_check=True)
        assert result["status"] == "repair_required"
        assert result["notification_failed"] is True
        assert saved[-1]["notification_failed"] is True
        assert saved[-1]["pending"] == reloaded["pending"]

        instance.api.notification = delivered
        result = await instance.check(force_check=True)
        assert result["status"] == "repair_required"
        assert result["notification_failed"] is False
        assert saved[-1]["notification_failed"] is False

    asyncio.run(recovery())


if __name__ == "__main__":
    host = Path(sys.argv[1])
    cooling(host)
    backups(host)
    guard(host)
    print(
        "Cooling, backup failure recovery and Yasno contracts passed; hardware/service calls stubbed."
    )
