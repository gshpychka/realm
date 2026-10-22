"""Audit a private, unpacked HA snapshot without contacting or modifying HA.

Only declaration-owned references and fixed diagnostics reach the report. Never
print config-entry values, user names, credentials, endpoint URLs or parse errors.
Registry presence establishes identity, not device reachability or capability.
"""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def targets(value, key):
    if isinstance(value, dict):
        if key in value:
            yield from strings(value[key])
        for child in value.values():
            yield from targets(child, key)
    elif isinstance(value, list):
        for child in value:
            yield from targets(child, key)


def device_references(value):
    """Native HA targets and device triggers use registry IDs; vendors do not."""
    if isinstance(value, dict):
        target = value.get("target")
        if isinstance(target, dict):
            yield from strings(target.get("device_id", []))
        if (
            value.get("trigger", value.get("platform")) == "device"
            or value.get("condition") == "device"
        ):
            yield from strings(value.get("device_id", []))
        for child in value.values():
            yield from device_references(child)
    elif isinstance(value, list):
        for child in value:
            yield from device_references(child)


def supervisor_endpoint(value):
    """Recognize add-on DNS names, including host values without a URL scheme."""
    try:
        host = urlsplit(value if "://" in value else "//" + value).hostname or ""
    except ValueError:
        return False
    return bool(
        host == "supervisor"
        or host.endswith(".hass.io")
        or re.fullmatch(r"(?:core|local|[0-9a-f]{8})[-_][a-z0-9_-]+", host)
    )


def local_entities(config):
    result = set()
    for domain in ("script", "input_boolean", "input_button", "timer"):
        result.update(f"{domain}.{key}" for key in config.get(domain, {}))
    for domain in ("scene", "binary_sensor", "media_player"):
        for item in config.get(domain, []):
            if "name" in item:
                slug = re.sub(r"[^a-z0-9_]+", "_", item["name"].lower()).strip("_")
                result.add(f"{domain}.{slug}")
    return result


def audit(config_dir, declarations):
    config = declarations["configuration"]
    findings = []

    def issue(code, message, reference=None, severity="error"):
        finding = {"severity": severity, "code": code, "message": message}
        if reference is not None:
            finding["reference"] = reference
        findings.append(finding)

    def storage(name, field, kind):
        try:
            document = json.loads((config_dir / ".storage" / name).read_text())
            data = document["data"]
            result = data if field is None else data[field]
            if not isinstance(result, kind):
                raise TypeError
            if isinstance(result, list) and not all(
                isinstance(x, dict) for x in result
            ):
                raise TypeError
            required = {
                "core.config_entries": ("entry_id", "domain"),
                "core.entity_registry": ("entity_id",),
                "core.device_registry": ("id",),
                "core.area_registry": ("id",),
            }.get(name, ())
            if any(
                not isinstance(item.get(key), str) or not item[key]
                for item in result
                for key in required
            ):
                raise TypeError
            return result
        except (OSError, ValueError, KeyError, TypeError):
            issue(
                "state-unreadable", f"Required .storage/{name} is missing or invalid."
            )
            return kind()

    entries = storage("core.config_entries", "entries", list)
    registry = storage("core.entity_registry", "entities", list)
    devices = storage("core.device_registry", "devices", list)
    areas = storage("core.area_registry", "areas", list)
    auth = storage("auth", None, dict)
    if not all(
        isinstance(auth.get(key), list)
        and auth[key]
        and all(isinstance(item, dict) for item in auth[key])
        for key in ("users", "refresh_tokens")
    ):
        issue(
            "authentication-incomplete", "Authentication lacks users or refresh tokens."
        )
    if not (config_dir / "home-assistant_v2.db").is_file():
        issue(
            "history-missing",
            "Recorder database is absent; preserve history separately or explicitly accept its loss.",
        )
    if (
        not (config_dir / ".ssh/outbound_key").is_file()
        or not (config_dir / ".ssh/known_hosts").is_file()
    ):
        issue("ssh-state-missing", "Outbound SSH key or pinned known_hosts is absent.")

    for entry in entries:
        # Report only allowlisted domain names from the public declarations.
        if any(supervisor_endpoint(value) for value in strings(entry)):
            issue(
                "supervisor-endpoint",
                "A config entry uses Supervisor/add-on DNS. Reconfigure it through HA before accepting the native controller.",
            )
        if entry.get("domain") == "hassio":
            issue(
                "supervisor-entry",
                "Remove the restored Supervisor integration through HA; native NixOS has no Supervisor.",
            )

    # Non-registry YAML entities may be evidenced by HA's own restore-state
    # snapshot. This is optional and does not prove current availability.
    restored = set()
    restore_file = config_dir / ".storage/core.restore_state"
    if restore_file.exists():
        for item in storage("core.restore_state", None, list):
            state = item.get("state", {})
            if isinstance(state, dict) and isinstance(state.get("entity_id"), str):
                restored.add(state["entity_id"])
    by_entity = {
        e["entity_id"]: e for e in registry if isinstance(e.get("entity_id"), str)
    }
    entry_by_id = {
        e["entry_id"]: e for e in entries if isinstance(e.get("entry_id"), str)
    }
    declared_text = json.dumps(config)
    references = {
        e
        for e in strings(declarations["entities"])
        if re.search(r"(?<![a-z0-9_])" + re.escape(e) + r"(?![a-z0-9_])", declared_text)
    }
    references.update(
        e
        for e in targets(config, "entity_id")
        if re.fullmatch(r"[a-z_]+\.[a-z0-9_]+", e)
    )
    for entity in sorted(references - local_entities(config)):
        record = by_entity.get(entity)
        if record is None and entity not in restored:
            issue(
                "entity-missing",
                "Referenced external entity is absent from registries and restore state.",
                entity,
            )
        elif record is not None and (
            record.get("disabled_by") is not None
            or entry_by_id.get(record.get("config_entry_id"), {}).get("disabled_by")
            is not None
        ):
            issue(
                "entity-disabled",
                "Referenced external entity or its integration is disabled.",
                entity,
            )

    known_devices = {d.get("id") for d in devices if isinstance(d.get("id"), str)}
    for device in sorted(set(device_references(config))):
        if device not in known_devices:
            issue(
                "device-missing",
                "Referenced HA device is absent from the restored registry.",
                device,
            )
    known_areas = {a.get("id") for a in areas if isinstance(a.get("id"), str)}
    for area in sorted(set(targets(config, "area_id"))):
        if area not in known_areas:
            issue(
                "area-missing",
                "Referenced area is absent from the restored registry.",
                area,
            )

    # Restored IDs for entities formerly declared without matching unique IDs
    # reserve their names. HA may silently allocate a suffixed replacement.
    for domain, definitions in (
        ("automation", config.get("automation", [])),
        ("scene", config.get("scene", [])),
    ):
        desired_ids = {str(item["id"]) for item in definitions if "id" in item}
        for entity, record in by_entity.items():
            if (
                entity.startswith(domain + ".")
                and str(record.get("unique_id")) not in desired_ids
            ):
                issue(
                    "identity-review",
                    f"Restored {domain} registry identity has no matching declaration. Review callers and enabled state privately.",
                    severity="warning",
                )
        if domain == "scene":
            for definition in definitions:
                unique_id = str(definition.get("id"))
                expected = "scene." + re.sub(
                    r"[^a-z0-9_]+", "_", definition["name"].lower()
                ).strip("_")
                reserved = by_entity.get(expected)
                if (
                    expected in references
                    and reserved is not None
                    and str(reserved.get("unique_id")) != unique_id
                ):
                    issue(
                        "scene-identity-conflict",
                        "A different restored scene identity reserves the name used by declared callers. Reconcile through HA.",
                        expected,
                    )
                for entity, record in by_entity.items():
                    if (
                        entity.startswith("scene.")
                        and str(record.get("unique_id")) == unique_id
                        and expected in references
                        and entity != expected
                    ):
                        issue(
                            "scene-renamed",
                            "Restored scene identity has a different entity name from its declared callers. Reconcile through HA.",
                            expected,
                        )

    return {
        "status": "blocked"
        if any(f["severity"] == "error" for f in findings)
        else "needs-acceptance",
        "findings": findings,
        "acceptance_required": [
            "Consistent recovery backup and tested restore, including Matter fabrics and broker state.",
            "Private service credentials, all MQTT clients, and native config-flow endpoints.",
            "Pi boot, networking/IPv6, device capabilities, automations, voice pipelines and rollback.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(
        prog="home-assistant-preflight", description=__doc__
    )
    parser.add_argument(
        "config_dir",
        type=Path,
        help="Private unpacked HA configuration snapshot (not a live directory)",
    )
    parser.add_argument(
        "--declarations",
        type=Path,
        required=True,
        help="Public evaluated declarations; supplied by the flake app",
    )
    args = parser.parse_args()
    try:
        declarations = json.loads(args.declarations.read_text())
        if (
            not isinstance(declarations, dict)
            or not isinstance(declarations.get("configuration"), dict)
            or not isinstance(declarations.get("entities"), dict)
        ):
            raise ValueError
        report = audit(args.config_dir, declarations)
    except (OSError, ValueError, KeyError, TypeError):
        parser.exit(
            2,
            "Could not read declarations or snapshot; values are omitted to protect credentials.\n",
        )
    print(json.dumps(report, indent=2))
    return 1 if report["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
