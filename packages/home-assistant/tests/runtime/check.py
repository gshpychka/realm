"""Offline contracts for cooling, consistent backups and the Yasno app.

All filesystem writes use temporary directories; systemctl and I2C are stubs.
"""

import asyncio
import importlib.util
import math
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
    fan = module("argonone", host / "runtime" / "argonone" / "argonone.py")
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
    checks = module("backup_checks", Path(__file__).with_name("backup.py"))
    checks.run(host, module)


def guard(host):
    directory = host / "runtime" / "yasno-address-guard"
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

        # Concurrent provider and notification failures persist the original
        # error, delivery status and next retry time together.
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

        # Successful notification delivery clears the persisted delivery failure
        # while a provider-validation failure schedules another retry.
        async def delivered(_message):
            pass

        instance.group = unavailable
        instance.api.notification = delivered
        result = await instance.check(force_check=True)
        assert result["status"] == "check_failed"
        assert result["notification_failed"] is False
        assert saved[-1]["notification_failed"] is False
        assert saved[-1]["error"] == "official_lookup_validation_or_correction_failed"

        # Successful verification clears the persisted delivery-failure status.
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
