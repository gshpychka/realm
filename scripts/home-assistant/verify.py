#!/usr/bin/env python3
"""Offline semantic, identity, credential-boundary and contract verification.

Reads protected inventory locally. Prints only check names/counts, never values
or diffs from private state. No network or live service actions are performed.
"""

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import sqlite3
import sys
import tarfile
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--private-secrets", type=Path, required=True)
    parser.add_argument("--prepared-state", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    public = root / "machines/home-assistant"
    source = args.inventory / "source"
    checks = []

    def ensure(condition, label):
        if not condition:
            raise RuntimeError(label)
        checks.append(label)

    exporter = module("exporter", Path(__file__).with_name("export-inventory.py"))
    private = exporter.load(args.private_secrets)

    def resolve(value):
        if isinstance(value, dict):
            return {key: resolve(child) for key, child in value.items()}
        if isinstance(value, list):
            return [resolve(child) for child in value]
        if isinstance(value, str) and value.startswith("!secret "):
            return resolve(private[value[len("!secret ") :]])
        return value

    def normalize(value):
        if isinstance(value, dict):
            return {
                key: normalize(
                    {
                        kind: {} if options is None else options
                        for kind, options in child.items()
                    }
                    if key == "selector" and isinstance(child, dict)
                    else child
                )
                for key, child in value.items()
            }
        if isinstance(value, list):
            return [normalize(child) for child in value]
        if isinstance(value, str) and value.startswith("/config/"):
            return "/var/lib/hass/" + value[len("/config/") :]
        return value

    config = json.loads((public / "configuration.json").read_text())

    def null_in_native_attributes(value):
        # Nix's attribute filter recurses through mappings, but not lists.
        return isinstance(value, dict) and any(
            child is None or null_in_native_attributes(child)
            for child in value.values()
        )

    ensure(
        not null_in_native_attributes(config),
        "declarative_types_survive_native_null_filter",
    )
    actual = resolve(config)
    original = exporter.load(source / "automations.yaml")
    aliases = json.loads((public / "automation-map.json").read_text())
    ensure(
        len(original) == len(config["automation"]) == len(aliases) == 51,
        "all_51_automations",
    )
    for old, new, mapping in zip(original, actual["automation"], aliases, strict=True):
        expected = normalize(copy.deepcopy(old))
        expected["alias"] = mapping["alias"]
        expected["initial_state"] = mapping["enabled"]
        ensure(expected == new, "automation_semantics_" + old["id"])
    source_by_id = {item["id"]: item for item in original}
    for item in json.loads((args.inventory / "haAutomationsFull.json").read_text()):
        api = item["data"]["config"]
        disk = source_by_id[api["id"]]
        ensure(
            all(api.get(key) == value for key, value in disk.items()),
            "api_automation_agrees_" + api["id"],
        )
    source_scripts = exporter.load(source / "scripts.yaml")
    ensure(
        normalize(source_scripts) == actual["script"],
        "all_eight_script_definitions_semantically_preserved",
    )
    api_scripts = json.loads((args.inventory / "haScriptsFull.json").read_text())
    ensure(len(api_scripts) == 4, "four_active_scripts")
    for item in api_scripts:
        ensure(
            item["data"]["config"]
            == source_scripts[item["id"].removeprefix("script.")],
            "active_script_api_agrees_" + item["id"],
        )
    ensure(
        normalize(exporter.load(source / "scenes.yaml")) == actual["scene"],
        "both_scenes_unchanged",
    )
    for domain in ["input_boolean", "input_button", "timer"]:
        entries = json.loads((source / ".storage" / domain).read_text())["data"][
            "items"
        ]
        ensure(
            {
                item["id"]: {key: value for key, value in item.items() if key != "id"}
                for item in entries
            }
            == actual[domain],
            "yaml_helper_identity_" + domain,
        )
    for name in ["reaper_windows", "turn_off_reaper"]:
        text = config["shell_command"][name]
        ensure(
            "StrictHostKeyChecking=yes" in text
            and "BatchMode=yes" in text
            and "StrictHostKeyChecking=no" not in text,
            "outbound_strict_ssh_" + name,
        )
    guard = actual["pyscript"]["apps"]["yasno_address_guard"]
    ensure(
        guard["journal_path"] == "/var/lib/hass/yasno-address-guard/journal.json",
        "guard_journal_writable_outside_source",
    )
    for path in (source / "pyscript/apps/yasno_address_guard").glob("*.py"):
        ensure(
            path.read_bytes()
            == (public / "yasno-address-guard" / path.name).read_bytes(),
            "guard_source_verbatim_" + path.name,
        )

    coverage = json.loads((public / "integration-coverage.json").read_text())
    before = json.loads((source / ".storage/core.config_entries").read_text())
    after = json.loads(
        (args.prepared_state / ".storage/core.config_entries").read_text()
    )
    ensure(
        len(coverage) == 92
        and {entry["entry_id"] for entry in coverage}
        == {entry["entry_id"] for entry in before["data"]["entries"]},
        "every_config_entry_classified",
    )
    ensure(
        all(
            entry["reason"] and entry["evidence"] and entry["status"]
            for entry in coverage
        ),
        "coverage_has_reason_and_evidence",
    )
    removed = {
        entry["entry_id"]
        for entry in before["data"]["entries"]
        if entry["domain"] in {"hassio", "raspberry_pi"}
    }
    target_by_id = {entry["entry_id"]: entry for entry in after["data"]["entries"]}
    ensure(
        list(target_by_id)
        == [
            entry["entry_id"]
            for entry in before["data"]["entries"]
            if entry["entry_id"] not in removed
        ]
        and len(removed) == 2,
        "only_two_platform_entries_removed_and_order_preserved",
    )
    # Check the allowed difference set independently of the preparation helper.
    endpoint_changes = {
        "mqtt": {"broker": "127.0.0.1", "port": 1883},
        "matter": {
            "url": "ws://127.0.0.1:5580/ws",
            "use_addon": False,
            "integration_created_addon": False,
        },
        "glances": {"host": "127.0.0.1", "port": 61208},
    }
    for entry in before["data"]["entries"]:
        if entry["entry_id"] in removed:
            continue
        original, candidate = (
            copy.deepcopy(entry),
            copy.deepcopy(target_by_id[entry["entry_id"]]),
        )
        for key, value in endpoint_changes.get(entry["domain"], {}).items():
            ensure(
                candidate["data"].get(key) == value, "declared_native_endpoint_value"
            )
            candidate["data"].pop(key, None)
            original["data"].pop(key, None)
        declaration = next(
            row for row in coverage if row["entry_id"] == entry["entry_id"]
        )
        for key, value in declaration.get("native_options", {}).items():
            ensure(
                candidate["options"].get(key) == value, "declared_native_option_value"
            )
            candidate["options"].pop(key, None)
            original["options"].pop(key, None)
        ensure(
            candidate == original,
            "all_unrelated_entry_fields_and_credentials_preserved",
        )
    before_by_id = {entry["entry_id"]: entry for entry in before["data"]["entries"]}
    ensure(
        all(
            entry.get("disabled_by")
            == before_by_id[entry["entry_id"]].get("disabled_by")
            and entry["source"] == before_by_id[entry["entry_id"]]["source"]
            for entry in after["data"]["entries"]
        ),
        "disabled_and_discovery_ignored_states_preserved",
    )
    matter = next(
        entry for entry in after["data"]["entries"] if entry["domain"] == "matter"
    )
    for entry in after["data"]["entries"]:
        if entry["domain"] == "dlna_dmr":
            declaration = next(
                row for row in coverage if row["entry_id"] == entry["entry_id"]
            )
            ensure(
                entry["options"]["listen_port"] in declaration["required_tcp_ports"],
                "dlna_callback_matches_firewall",
            )
    ensure(
        not matter["data"]["use_addon"]
        and not matter["data"]["integration_created_addon"],
        "matter_no_supervisor_dependency",
    )
    entity_map = json.loads((public / "entity-map.json").read_text())
    original_entities = json.loads(
        (source / ".storage/core.entity_registry").read_text()
    )["data"]["entities"]
    target_entities = json.loads(
        (args.prepared_state / ".storage/core.entity_registry").read_text()
    )["data"]["entities"]
    ensure(
        len(entity_map) == len(original_entities) == 1864,
        "complete_entity_identifier_map",
    )
    ensure(
        sum(entry["disabled_by"] is not None for entry in original_entities) == 1058,
        "all_1058_disabled_entities_inventoried",
    )
    ensure(
        {entry["entity_id"] for entry in target_entities}
        == {entry["new"] for entry in entity_map if entry["new"]},
        "target_registry_matches_identifier_map",
    )
    ensure(
        all(entry in original_entities for entry in target_entities),
        "retained_entity_records_are_identical",
    )
    ensure(
        not (args.prepared_state / ".migration-ready").exists(),
        "inspection_state_cannot_start_ha",
    )
    ensure(
        not json.loads((args.prepared_state / "migration-readiness.json").read_text())[
            "ready"
        ],
        "inspection_snapshot_not_misrepresented_as_backup",
    )

    manifests = json.loads((public / "components.json").read_text())
    with tarfile.open(public / "components.tar.gz") as archive:
        for item in archive:
            ensure(
                item.isfile()
                and not item.name.startswith("/")
                and ".." not in Path(item.name).parts,
                "archive_safe_path",
            )
            domain, relative = item.name.split("/", 1)
            ensure(
                hashlib.sha256(archive.extractfile(item).read()).hexdigest()
                == manifests[domain]["files"][relative],
                "component_source_hash",
            )

    fan = module("fan", Path(__file__).with_name("argonone.py"))
    ensure(
        [fan.fan_speed(temp) for temp in [40, 55, 55.99, 60, 65, 70, 75, 90]]
        == [0, 0, 0, 25, 50, 75, 100, 100],
        "v3_installed_linear_profile",
    )
    for invalid in [math.nan, math.inf, -100, 200]:
        try:
            fan.fan_speed(invalid)
        except ValueError:
            pass
        else:
            raise RuntimeError("fan_invalid_temperature_accepted")
    writes = []

    class FakeBus:
        def write_byte_data(self, address, register, value):
            writes.append((address, register, value))

    fan.write_speed(FakeBus(), 100)
    ensure(writes == [(0x1A, 0x80, 100)], "v3_register_protocol_not_pi4_write_byte")
    flow = module("guard_flow", public / "yasno-address-guard/flow_contract.py")
    settings = {
        "region": "test",
        "provider": "test",
        "scan_interval": 15,
        "filter_probable": True,
        "status_all_day_events": True,
    }
    ensure(
        flow.next_input(
            {"type": "abort", "reason": "reconfigure_successful"}, {}, "1.1"
        )
        is None,
        "guard_accepts_only_successful_commit",
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
            raise RuntimeError("guard_flow_did_not_fail_closed")
    ensure(True, "guard_rejects_unknown_or_failed_flow")
    slots = module("guard_slots", public / "yasno-address-guard/validation.py")
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
            raise RuntimeError("guard_schedule_did_not_fail_closed")
    ensure(True, "guard_rejects_overlapping_or_invalid_slots")

    # Exercise the future backup's failure/restore behavior entirely inside a
    # temporary fake filesystem. Every systemctl operation is an in-memory stub.
    backup = module("backup", Path(__file__).with_name("consistent-backup.py"))
    for corrupt in [False, True]:
        with tempfile.TemporaryDirectory(prefix="ha-backup-contract-") as temporary:
            fake_root = Path(temporary)
            for name in [
                "hass",
                "matter-server",
                "mosquitto",
                "private/home-assistant",
                "ha-mcp",
                "tailscale",
                "bluetooth",
            ]:
                (fake_root / "var/lib" / name).mkdir(parents=True, exist_ok=True)
            (fake_root / "run/lock").mkdir(parents=True)
            (fake_root / "etc/ssh").mkdir(parents=True)
            (fake_root / "etc/ssh/ssh_host_ed25519_key").write_text(
                "synthetic host-key fixture"
            )
            (fake_root / "var/lib/private/home-assistant/.backup-enabled").touch()
            current = fake_root / "var/lib/home-assistant-backup"
            current.mkdir()
            (current / "old-snapshot").write_text("synthetic previous snapshot")
            for name in ["home-assistant_v2.db", "zigbee.db"]:
                with sqlite3.connect(fake_root / "var/lib/hass" / name) as connection:
                    connection.execute("CREATE TABLE test (id INTEGER)")
            if corrupt:
                (fake_root / "var/lib/hass/zigbee.db").write_bytes(
                    b"invalid synthetic SQLite"
                )
            operations = []

            def fake_command(*arguments, operations=operations, **_kwargs):
                operations.append(arguments)
                active = arguments[-1] in {"home-assistant", "mosquitto", "bluetooth"}
                return SimpleNamespace(
                    returncode=0 if "is-active" not in arguments or active else 3
                )

            backup.Path = lambda path, fake_root=fake_root: (
                fake_root / str(path).lstrip("/")
            )
            backup.command = fake_command
            with patch.object(sys, "argv", ["backup-contract", "--operator-enabled"]):
                try:
                    backup.main()
                except sqlite3.DatabaseError:
                    ensure(corrupt, "backup_only_expected_failure")
            ensure(
                ("systemctl", "stop", "home-assistant", "mosquitto", "bluetooth")
                in operations,
                "backup_stops_only_previously_active_services",
            )
            ensure(
                operations[-1]
                == ("systemctl", "start", "bluetooth", "mosquitto", "home-assistant"),
                "backup_restores_prior_active_services_even_on_failure",
            )
            if corrupt:
                ensure(
                    (current / "old-snapshot").exists()
                    and not (current / ".consistent-snapshot").exists(),
                    "failed_backup_does_not_replace_good_snapshot",
                )
            else:
                ensure(
                    (current / ".consistent-snapshot").exists(),
                    "successful_backup_validates_and_commits_snapshot",
                )
                ensure((current / "bluetooth").is_dir(), "bluetooth_state_in_snapshot")
                key = current / "ssh-host-keys/ssh_host_ed25519_key"
                ensure(
                    key.read_text() == "synthetic host-key fixture"
                    and key.stat().st_mode & 0o777 == 0o600,
                    "ssh_server_identity_copied_privately",
                )

    secrets = set()

    def collect(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if (
                    exporter.SENSITIVE.fullmatch(str(key))
                    and isinstance(child, str)
                    and len(child) >= 8
                    and child not in exporter.PUBLIC_SENTINELS
                ):
                    secrets.add(child)
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(before)
    collect(exporter.load(source / "configuration.yaml"))
    secrets.update(
        value
        for value in private.values()
        if isinstance(value, str)
        and len(value) >= 8
        and value not in exporter.PUBLIC_SENTINELS
    )
    for folder in [public, root / "packages/home-assistant", Path(__file__).parent]:
        for path in folder.rglob("*"):
            if (
                path.is_file()
                and "__pycache__" not in path.parts
                and path.name != "components.tar.gz"
            ):
                ensure(
                    not any(secret.encode() in path.read_bytes() for secret in secrets),
                    "public_artifact_credential_scan",
                )
    print(
        json.dumps(
            {
                "semantic_identity_and_contract_checks": "passed",
                "component_source_hashes": "verified",
                "credential_scan": "passed",
                "automations": 51,
                "active_scripts": 4,
                "retained_disabled_scripts": 4,
                "config_entries": 92,
                "custom_components": len(manifests),
                "live_actions": 0,
                "private_values_printed": False,
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Keep private state, parser source lines and comparison values out of
        # tracebacks. Check labels, unlike exception text, are static above.
        label = str(error) if type(error) is RuntimeError else type(error).__name__
        print("Verification failed: " + label, file=sys.stderr)
        sys.exit(1)
