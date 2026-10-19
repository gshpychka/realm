#!/usr/bin/env python3
"""Create secret-free declarations from the protected, read-only HA inventory.

No network access. Credential values are written only to an explicit private
directory, never printed. The inspection snapshot is not a recovery backup.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
from pathlib import Path

import yaml
from private_paths import require_private_path


class Loader(yaml.SafeLoader):
    pass


Loader.add_multi_constructor(
    "!", lambda loader, tag, node: "!" + tag + " " + loader.construct_scalar(node)
)
SENSITIVE = re.compile(
    r"^(?:api[_-]?key|access_token|refresh_token|token|password|client_secret|"
    r"webhook_id|authorization|secret|secret_path|private_key)$",
    re.I,
)
# Local OpenAI-compatible endpoints use this public, noncredential sentinel.
PUBLIC_SENTINELS = {"placeholder"}


def load(path):
    return yaml.load(path.read_text(), Loader=Loader)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def category(alias):
    text = alias.lower()
    groups = {
        "Lighting": ["light", "lamp"],
        "Voice": ["assistant", "voice", "announcement", "announce", "assist"],
        "Power": ["power", "battery", "reaper", "hoard"],
        "Media": ["movie", "plex", "media", "soundbar", "tv", "goodnight"],
        "Devices": ["print", "zigbee", "leak", "dyson", "ac ", "button"],
    }
    return next(
        (name for name, words in groups.items() if any(w in text for w in words)),
        "System",
    )


def dependency_report(config, guard, source, mapping):
    by_id = {entry["old"]: entry for entry in mapping}
    domains = {name.split(".", 1)[0] for name in by_id} | {
        "sensor",
        "fan",
        "conversation",
        "stt",
        "tts",
        "pyscript",
    }
    entities, services, devices = {}, {}, {}
    pattern = re.compile(r"\b([a-z_]+)\.([a-z0-9_]+)\b")

    def visit(value, path):
        if isinstance(value, dict):
            for key, child in value.items():
                visit(child, path + [str(key)])
        elif isinstance(value, list):
            for index, child in enumerate(value):
                visit(child, path + [str(index)])
        elif isinstance(value, str):
            consumer = ".".join(path)
            if path[-1] in {"action", "service"} and re.fullmatch(
                r"[a-z_]+\.[a-z0-9_]+", value
            ):
                services.setdefault(value, []).append(consumer)
                return
            if any(key in {"device_id", "device_ids"} for key in path) and re.fullmatch(
                r"[0-9a-f]{32}", value
            ):
                devices.setdefault(value, []).append(consumer)
            for match in pattern.finditer(value):
                if match.group(1) in domains:
                    entities.setdefault(match.group(), []).append(consumer)

    visit(config, ["configuration"])
    visit(guard, ["protected_yasno_guard_bindings"])
    pipelines = json.loads((source / ".storage/assist_pipeline.pipelines").read_text())
    visit(pipelines, ["assist_pipeline.pipelines"])
    references = []
    for entity, consumers in sorted(entities.items()):
        row = by_id.get(entity)
        status = "retained"
        if row and not row["new"]:
            status = "removed-os-management-entity"
        elif row and row["disabled_by"]:
            status = "baseline-disabled-reference"
        elif not row:
            status = (
                "native-transient-sensor"
                if entity
                in {"sensor.argon_one_addon_fan_speed", "pyscript.yasno_address_guard"}
                else "baseline-not-in-registry"
            )
            if entity == "conversation.home_assistant":
                status = "builtin-conversation-agent"
            elif entity in {
                "assist_satellite.listening",
                "light.is_on",
                "light.is_off",
            }:
                status = "state-or-helper-name"
        references.append(
            {
                "entity_id": entity,
                "target": row["new"] if row else entity,
                "status": status,
                "consumers": sorted(set(consumers)),
            }
        )
    registry = json.loads((source / ".storage/core.device_registry").read_text())[
        "data"
    ]
    device_ids = {
        row[field]
        for key in ["devices", "child_devices"]
        for row in registry.get(key, [])
        for field in ["id", "composite_device_id"]
        if row.get(field)
    }
    return {
        "scope": "All declarations, private Yasno entity bindings and all five voice pipeline definitions. No private values or provider calls.",
        "entity_references": references,
        "service_references": [
            {"service": name, "consumers": sorted(set(paths))}
            for name, paths in sorted(services.items())
        ],
        "device_references": [
            {
                "device_id": name,
                "in_source_registry": name in device_ids,
                "consumers": sorted(set(paths)),
            }
            for name, paths in sorted(devices.items())
        ],
        "pipeline_count": len(pipelines["data"]["items"]),
        "native_entities": [
            {
                "entity_id": "sensor.argon_one_addon_fan_speed",
                "declaration": "services.home-assistant.config.command_line",
                "baseline": "transient add-on REST state",
            }
        ],
    }


def export(inventory, destination, private):
    require_private_path(private)
    source = inventory / "source"
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    if private.stat().st_mode & 0o777 != 0o700:
        raise ValueError("private output directory must already be mode 0700")
    secrets = load(source / "secrets.yaml") or {}
    known_secrets = set()

    def collect(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if (
                    SENSITIVE.fullmatch(str(key))
                    and isinstance(child, str)
                    and len(child) >= 8
                    and child not in PUBLIC_SENTINELS
                ):
                    known_secrets.add(child)
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    config = load(source / "configuration.yaml")
    automations = load(source / "automations.yaml")
    scripts = load(source / "scripts.yaml")
    # HA treats a null selector configuration as an empty mapping. NixOS's
    # generic YAML module removes null attributes, which would erase the
    # selector's type entirely. Declare the equivalent mapping explicitly.
    for definition in scripts.values():
        for field in definition.get("fields", {}).values():
            if isinstance(field.get("selector"), dict):
                field["selector"] = {
                    kind: {} if options is None else options
                    for kind, options in field["selector"].items()
                }
    scenes = load(source / "scenes.yaml")
    entries = json.loads((source / ".storage/core.config_entries").read_text())["data"][
        "entries"
    ]
    for value in [config, automations, scripts, scenes, entries, secrets]:
        collect(value)
    known_secrets.update(
        v for v in secrets.values() if isinstance(v, str) and len(v) >= 8
    )

    def protect(value, path=()):
        if isinstance(value, dict):
            result = {}
            for key, child in value.items():
                if SENSITIVE.fullmatch(str(key)) and child is not None:
                    name = "migration_" + "_".join(
                        re.sub(r"\W+", "_", str(p)) for p in (*path, key)
                    )
                    secrets[name] = child
                    result[key] = "!secret " + name
                else:
                    result[key] = protect(child, (*path, key))
            return result
        if isinstance(value, list):
            return [protect(child, (*path, index)) for index, child in enumerate(value)]
        if isinstance(value, str):
            # A whole scalar remains a whole scalar; templates/URLs are not
            # reconstructed with unsafe textual substitutions at runtime.
            if any(secret in value for secret in known_secrets):
                name = "migration_" + "_".join(
                    re.sub(r"\W+", "_", str(p)) for p in path
                )
                secrets[name] = value
                return "!secret " + name
            return (
                "/var/lib/hass/" + value[len("/config/") :]
                if value.startswith("/config/")
                else value
            )
        return value

    registry = json.loads((source / ".storage/core.entity_registry").read_text())[
        "data"
    ]["entities"]
    states = {
        e["entity_id"]: e["state"]
        for e in json.loads((inventory / "haAutomationEntities.json").read_text())[
            "entities"
        ]
    }
    automation_registry = {
        e["unique_id"]: e for e in registry if e["platform"] == "automation"
    }
    aliases = []
    for item in automations:
        old_alias = item["alias"]
        item["alias"] = (
            category(old_alias) + " / " + old_alias[0].upper() + old_alias[1:]
        )
        row = automation_registry.get(item["id"], {})
        state = states.get(row.get("entity_id"))
        if state not in ["on", "off"]:
            raise ValueError("automation enabled state was not inventoried")
        item["initial_state"] = state == "on"
        aliases.append(
            {
                "id": item["id"],
                "entity_id": row["entity_id"],
                "old_alias": old_alias,
                "alias": item["alias"],
                "enabled": state == "on",
            }
        )

    config.pop("frontend", None)  # Dashboard themes are explicitly optional.
    config["default_config"] = {}
    config["frontend"] = {}
    config["automation"] = automations
    config["script"] = scripts
    config["scene"] = scenes
    # The guard configuration contains a residential address. Keep the entire
    # dictionary private, including its existing entry and entity bindings.
    guard = config["pyscript"]["apps"]["yasno_address_guard"]
    guard["journal_path"] = "/var/lib/hass/yasno-address-guard/journal.json"
    secrets["yasno_address_guard"] = protect(guard)
    config["pyscript"]["apps"]["yasno_address_guard"] = "!secret yasno_address_guard"
    for domain in ["input_boolean", "input_button", "timer"]:
        items = json.loads((source / ".storage" / domain).read_text())["data"]["items"]
        config[domain] = {
            item["id"]: {k: v for k, v in item.items() if k != "id"} for item in items
        }
    for key, value in config["shell_command"].items():
        config["shell_command"][key] = value.replace(
            "-o StrictHostKeyChecking=no -i /config/.ssh/id_ed25519",
            "-o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/hass/.ssh/known_hosts -o IdentitiesOnly=yes -i /var/lib/hass/.ssh/outbound_key",
        )
    config = protect(config, ("configuration",))
    write_json(destination / "configuration.json", config)
    write_json(destination / "automation-map.json", aliases)
    write_json(
        destination / "entity-map.json",
        [
            {
                "old": e["entity_id"],
                "new": None
                if e["platform"] in ["hassio", "raspberry_pi"]
                else e["entity_id"],
                "platform": e["platform"],
                "config_entry_id": e["config_entry_id"],
                "disabled_by": e["disabled_by"],
                **(
                    {
                        "reason": "Supervisor/HAOS management entity removed; manage the equivalent native OS service instead."
                    }
                    if e["platform"] in ["hassio", "raspberry_pi"]
                    else {}
                ),
            }
            for e in registry
        ],
    )

    flow_helpers = {"template", "min_max", "filter", "switch_as_x", "person"}
    replacements = {
        "hassio": "Native OS services replace Supervisor; its UI/API/update entities do not exist on NixOS.",
        "raspberry_pi": "HAOS management entry is omitted; native RPi5 firmware/kernel and monitoring replace it.",
    }
    coverage = []
    for entry in entries:
        domain = entry["domain"]
        status = "protected-runtime-state"
        reason = "Preserve config-flow/OAuth/pairing data and registry identities through the offline handover. Installing code alone does not configure this integration."
        if domain in replacements:
            status, reason = "os-service-replacement", replacements[domain]
        elif entry["source"] == "ignore" or entry.get("disabled_by"):
            status, reason = (
                "preserved-inactive",
                "Preserve discovery-ignore and disabled_by exactly; do not enable during migration.",
            )
        elif domain == "sun":
            status, reason = (
                "declarative-yaml",
                "Loaded by default_config; retain its existing entry and identity.",
            )
        elif domain in flow_helpers:
            reason = "UI-created helper definition remains protected runtime config-entry state to retain its unique IDs and all dependencies."
        elif domain == "mqtt":
            reason = "Preserve identity/options; offline rewrite broker to 127.0.0.1:1883 and provision equivalent native broker credentials. Supervisor-generated authentication is not portable."
        elif domain == "matter":
            reason = "Preserve identity; offline rewrite URL to ws://127.0.0.1:5580/ws. Restore Matter fabrics independently from a consistent stopped-service backup."
        elif domain == "homekit":
            reason = "Preserve bridge identity, pairing, filter and configured port. The firewall consumes required_tcp_ports from this coverage row instead of assuming the default bridge port."
        elif domain == "dlna_dmr":
            reason = "Preserve identity and options; offline pin an unset random event-listener port to 32100 so device event callbacks cross the native firewall. Preserve an existing explicit port. No live subscription is changed."
        elif domain == "go2rtc":
            reason = "Core-managed go2rtc executable is supplied by the native HA module; preserve the entry. Camera operation requires target testing."
        coverage.append(
            {
                "entry_id": entry["entry_id"],
                "domain": domain,
                "source": entry["source"],
                "disabled_by": entry.get("disabled_by"),
                "status": status,
                "reason": reason,
                "evidence": "source/.storage/core.config_entries; haIntegrations.json",
                **(
                    {"required_tcp_ports": [entry["data"]["port"]]}
                    if domain == "homekit"
                    else {}
                ),
                **(
                    {
                        "native_options": {
                            "listen_port": entry["options"].get("listen_port") or 32100
                        },
                        "required_tcp_ports": [
                            entry["options"].get("listen_port") or 32100
                        ],
                    }
                    if domain == "dlna_dmr"
                    else {}
                ),
                "baseline_state": next(
                    (
                        e["state"]
                        for e in json.loads(
                            (inventory / "haIntegrations.json").read_text()
                        )["entries"]
                        if e["entry_id"] == entry["entry_id"]
                    ),
                    "unknown",
                ),
            }
        )
    write_json(destination / "integration-coverage.json", coverage)
    devices = json.loads((source / ".storage/core.device_registry").read_text())["data"]
    removed_entries = {
        entry["entry_id"]
        for entry in entries
        if entry["domain"] in {"hassio", "raspberry_pi"}
    }
    device_links = {}
    for key in ["devices", "child_devices"]:
        for device in devices.get(key, []):
            for field in ["id", "composite_device_id"]:
                if device.get(field):
                    device_links.setdefault(device[field], []).append(
                        device.get("config_entry_id") not in removed_entries
                    )
    write_json(
        destination / "device-map.json",
        [
            {
                "old": identity,
                "new": identity if any(retained) else None,
                "reason": "Preserve record/composite identity"
                if any(retained)
                else "Supervisor/HAOS-only device record removed",
            }
            for identity, retained in sorted(device_links.items())
        ],
    )
    write_json(
        destination / "dependency-coverage.json",
        dependency_report(
            config,
            guard,
            source,
            json.loads((destination / "entity-map.json").read_text()),
        ),
    )
    ssh_options = json.loads((inventory / "app-core_ssh.json").read_text())["addon"][
        "options"
    ]
    ssh_keys = ssh_options.get("authorized_keys", [])
    if any(
        not isinstance(key, str)
        or not key.startswith(("ssh-", "ecdsa-"))
        or "PRIVATE" in key
        for key in ssh_keys
    ):
        raise ValueError("unexpected authorized-key format")
    write_json(destination / "ssh-authorized-keys.json", ssh_keys)
    catalog = json.loads((inventory / "nixpkgs-ha-component-catalog.json").read_text())
    write_json(
        destination / "inventory-summary.json",
        {
            "core_version": "2026.10.2",
            "config_entries": len(entries),
            "automations": len(automations),
            "scripts": len(scripts),
            "active_scripts": sum(
                e["platform"] == "script" and e["disabled_by"] is None for e in registry
            ),
            "scenes": len(scenes),
            "entities": len(registry),
            "disabled_entities": sum(e["disabled_by"] is not None for e in registry),
            "secret_names": sorted(secrets),
            "snapshot_is_consistent_backup": False,
            "catalog_keys": list(catalog),
        },
    )
    custom = {}
    records = json.loads((inventory / "haHacsInstalled.json").read_text())["data"][
        "results"
    ]
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for component in sorted((source / "custom_components").iterdir()):
            if not component.is_dir():
                continue
            manifest = json.loads((component / "manifest.json").read_text())
            record = next((r for r in records if r.get("domain") == component.name), {})
            custom[component.name] = {
                "version": manifest["version"],
                "requirements": manifest.get("requirements", []),
                "dependencies": manifest.get("dependencies", []),
                "repository": record.get("full_name"),
                "installed_revision": record.get("installed_version"),
                "files": {},
            }
            for path in sorted(component.rglob("*")):
                if (
                    not path.is_file()
                    or "__pycache__" in path.parts
                    or path.suffix == ".pyc"
                ):
                    continue
                data = path.read_bytes()
                if any(secret.encode() in data for secret in known_secrets):
                    raise ValueError(
                        "credential found in component source; refusing export"
                    )
                relative = path.relative_to(source / "custom_components")
                info = tarfile.TarInfo(str(relative))
                info.size, info.mode, info.mtime = len(data), 0o444, 0
                archive.addfile(info, io.BytesIO(data))
                custom[component.name]["files"][str(path.relative_to(component))] = (
                    hashlib.sha256(data).hexdigest()
                )
    (destination / "components.tar.gz").write_bytes(
        gzip.compress(buffer.getvalue(), mtime=0)
    )
    write_json(destination / "components.json", custom)
    guard_target = destination / "yasno-address-guard"
    guard_target.mkdir(exist_ok=True)
    for path in sorted((source / "pyscript/apps/yasno_address_guard").glob("*.py")):
        data = path.read_bytes()
        if any(secret.encode() in data for secret in known_secrets):
            raise ValueError("credential found in guard source; refusing export")
        (guard_target / path.name).write_bytes(data)
    secret_path = private / "secrets.yaml"
    descriptor = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        yaml.safe_dump(secrets, stream, allow_unicode=True, sort_keys=True)
    # Preserve the installed app's options using its documented environment
    # aliases. Its Supervisor token is intentionally NOT copied or replaced with
    # the inherited Assist token: the owner must provision an admin HA token.
    mcp_options = json.loads((inventory / "app-81f33d0f_ha_mcp.json").read_text())[
        "addon"
    ]["options"]
    if mcp_options.get("custom_instructions"):
        raise ValueError(
            "nonempty legacy custom instructions need native option review"
        )
    aliases = {"verify_ssl": "HA_VERIFY_SSL"}
    mcp_settings = {
        aliases.get(key, key.upper()): value
        for key, value in mcp_options.items()
        if key not in {"secret_path", "custom_instructions"}
    }
    mcp_path = os.environ.get("HOME_ASSISTANT_ADMIN_MCP_PATH") or mcp_options.get(
        "secret_path"
    )
    if mcp_path:
        mcp_settings["MCP_SECRET_PATH"] = "/" + mcp_path.lstrip("/")
    env_path = private / "ha-mcp-settings.env"
    descriptor = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(
            "# Add HOMEASSISTANT_TOKEN privately during the authorized future restore.\n"
        )
        for name, value in sorted(mcp_settings.items()):
            text = (
                value
                if isinstance(value, str)
                else json.dumps(value, ensure_ascii=False)
            )
            # systemd EnvironmentFile double quoting permits literal newlines;
            # escape only backslashes and quotes, without shell evaluation.
            stream.write(
                name + '="' + text.replace("\\", "\\\\").replace('"', '\\"') + '"\n'
            )
    descriptor = os.open(
        private / "ha-mcp-app-options.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
    )
    with os.fdopen(descriptor, "w") as stream:
        json.dump(mcp_options, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    # Verify the public artifacts against all credential values before exiting.
    for path in destination.rglob("*"):
        if (
            path.is_file()
            and path.name != "components.tar.gz"
            and any(secret.encode() in path.read_bytes() for secret in known_secrets)
        ):
            raise ValueError("credential found in public artifact; refusing completion")
    print(
        json.dumps(
            {
                "entries": len(entries),
                "automations": len(automations),
                "scripts": len(scripts),
                "scenes": len(scenes),
                "custom_components": len(custom),
                "secret_values_printed": False,
            }
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--private-output", type=Path, required=True)
    args = parser.parse_args()
    if args.private_output.resolve().is_relative_to(args.destination.resolve()):
        parser.error("private output must be outside the public destination")
    try:
        export(args.inventory, args.destination, args.private_output)
    except Exception as error:
        # Parser exceptions may include the source line, including secrets.
        print(
            "Export failed: " + type(error).__name__ + "; no private values printed",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
