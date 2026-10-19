#!/usr/bin/env python3
"""Prepare a NEW offline state tree, never an active Home Assistant directory.

No network, provider operations, activation, keys, tokens or readiness markers
are created. The operator must separately review consistency and provisioning.
All output files can contain credentials and must remain outside Git/store.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from private_paths import require_private_path

REMOVED_DOMAINS = {"hassio", "raspberry_pi"}
YAML_HELPERS = {"input_boolean", "input_button", "timer"}


def transform_entries(storage, coverage):
    declared_options = {
        row["entry_id"]: row["native_options"]
        for row in coverage
        if row.get("native_options")
    }
    removed = {
        e["entry_id"]
        for e in storage["data"]["entries"]
        if e["domain"] in REMOVED_DOMAINS
    }
    result = []
    for entry in storage["data"]["entries"]:
        if entry["entry_id"] in removed:
            continue
        if entry["domain"] == "mqtt":
            if "broker" not in entry["data"]:
                raise ValueError("unsupported MQTT state schema")
            entry["data"]["broker"] = "127.0.0.1"
            entry["data"]["port"] = 1883
        elif entry["domain"] == "matter":
            if "url" not in entry["data"]:
                raise ValueError("unsupported Matter state schema")
            entry["data"]["url"] = "ws://127.0.0.1:5580/ws"
            entry["data"]["use_addon"] = False
            entry["data"]["integration_created_addon"] = False
        elif entry["domain"] == "glances":
            # This is the currently disabled Glances app entry. Retain its
            # disabled flag while removing its dependency on Supervisor DNS.
            entry["data"]["host"] = "127.0.0.1"
            entry["data"]["port"] = 61208
        if entry["entry_id"] in declared_options:
            options = declared_options[entry["entry_id"]]
            if (
                entry["domain"] != "dlna_dmr"
                or set(options) != {"listen_port"}
                or not isinstance(options["listen_port"], int)
                or not 1 <= options["listen_port"] <= 65535
            ):
                raise ValueError("unreviewed native integration option rewrite")
            entry["options"].update(options)
        result.append(entry)
    storage["data"]["entries"] = result
    return removed


def prepare(source, destination, declarations, consistent=False):
    for path in [source, destination]:
        require_private_path(path)
    if destination.exists() or destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("destination must be a new offline tree outside the source")
    storage = json.loads((source / ".storage/core.config_entries").read_text())
    coverage = json.loads((declarations / "integration-coverage.json").read_text())
    expected = {e["entry_id"] for e in coverage}
    if {e["entry_id"] for e in storage["data"]["entries"]} != expected:
        raise ValueError(
            "config-entry inventory changed; refresh coverage before preparing state"
        )
    removed = transform_entries(storage, coverage)
    os.umask(0o077)
    destination.mkdir(mode=0o700, parents=True)
    target_storage = destination / ".storage"
    target_storage.mkdir(mode=0o700)
    for path in (source / ".storage").iterdir():
        # Never follow a backup symlink outside its declared state directory.
        if path.is_symlink() or not path.is_file():
            raise ValueError("unexpected state tree entry")
        if path.name not in YAML_HELPERS and not path.name.startswith("lovelace"):
            shutil.copyfile(path, target_storage / path.name)
    (target_storage / "core.config_entries").write_text(json.dumps(storage) + "\n")
    registry_path = target_storage / "core.entity_registry"
    registry = json.loads(registry_path.read_text())
    registry["data"]["entities"] = [
        e
        for e in registry["data"]["entities"]
        if e.get("config_entry_id") not in removed
        and e.get("platform") not in REMOVED_DOMAINS
    ]
    registry_path.write_text(json.dumps(registry) + "\n")
    devices_path = target_storage / "core.device_registry"
    devices = json.loads(devices_path.read_text())
    for key in ["devices", "child_devices", "deleted_devices"]:
        if key not in devices["data"]:
            continue
        retained = []
        for device in devices["data"][key]:
            # 2026.10 stores per-entry devices and composite/child records.
            # Older snapshots used a config_entries list. Never reinterpret
            # one schema as the other or drop an unrelated disabled device.
            if device.get("config_entry_id") in removed:
                continue
            if "config_entries" in device:
                old_entries = device["config_entries"]
                device["config_entries"] = [
                    entry for entry in old_entries if entry not in removed
                ]
                if old_entries and not device["config_entries"]:
                    continue
            retained.append(device)
        devices["data"][key] = retained
    devices_path.write_text(json.dumps(devices) + "\n")
    for name in ["home-assistant_v2.db", "zigbee.db"]:
        path = source / name
        if path.is_file() and not path.is_symlink():
            if any((source / (name + suffix)).exists() for suffix in ["-wal", "-shm"]):
                raise ValueError(
                    "SQLite sidecars require a stopped/checkpointed backup"
                )
            shutil.copyfile(path, destination / name)
    # No guessing or generating outbound SSH authority. Keep the original key
    # in its protected backup until the operator explicitly provisions it.
    missing = []
    for name in [
        "auth",
        "auth_provider.homeassistant",
        "core.uuid",
        "core.entity_registry",
        "core.device_registry",
        "assist_pipeline.pipelines",
        "thread.datasets",
    ]:
        if not (target_storage / name).is_file():
            missing.append("HA .storage/" + name)
    for name in ["home-assistant_v2.db", "zigbee.db"]:
        if not (destination / name).is_file():
            missing.append(name + " consistent database backup")
    missing.extend(
        [
            "Matter server stopped-service fabric/data backup",
            "Mosquitto persistent database and complete client credentials",
            "Original outbound SSH private key and independently trusted reaper host keys",
            "Original SSH server host keys and reviewed Bluetooth adapter/bond state",
            "Yasno guard transaction journal (including any pending rollback)",
            "Runtime secrets.yaml, HA admin MCP token/path/options, backup credentials",
            "Native Tailscale state handover or owner-approved reauthentication",
            "Target physical boot, cooling, Bluetooth, IPv6 and radio acceptance",
            "Review pre-existing missing speaker references in active announcements",
        ]
    )
    report = {
        "source_claimed_consistent": consistent,
        "inspection_snapshot_is_backup": False,
        "ready": False,
        "removed_config_entries": sorted(removed),
        "changed_endpoints": [
            "mqtt -> 127.0.0.1:1883",
            "matter -> ws://127.0.0.1:5580/ws",
            "disabled glances -> 127.0.0.1:61208",
        ],
        "required_operator_inputs": missing,
        "readiness_marker_created": False,
        "changed_integration_options": {
            row["entry_id"]: row["native_options"]
            for row in coverage
            if row.get("native_options")
        },
    }
    (destination / "migration-readiness.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument(
        "--declarations",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "machines/home-assistant",
    )
    parser.add_argument("--consistent-stopped-backup", action="store_true")
    args = parser.parse_args()
    try:
        report = prepare(
            args.source,
            args.destination,
            args.declarations,
            args.consistent_stopped_backup,
        )
    except Exception as error:
        print(
            "Offline preparation failed: "
            + type(error).__name__
            + "; no private values printed",
            file=sys.stderr,
        )
        return 1
    print(
        json.dumps(
            {
                "ready": report["ready"],
                "readiness_marker_created": False,
                "required_operator_inputs": len(report["required_operator_inputs"]),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
