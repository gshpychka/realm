"""Exercise the shell driver against recorded Core config-flow HTTP contracts."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = (
    Path(sys.argv.pop(1))
    if len(sys.argv) > 1
    else Path(__file__).parents[2] / "migration/reconcile-ha.sh"
)

FAKE_CURL = r"""
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
method = args[args.index("-X") + 1]
url = args[-1]
path = url.split(":", 2)[2].split("/", 1)[1]
payload = None
if "--data-binary" in args:
    payload = json.loads(Path(args[args.index("--data-binary") + 1][1:]).read_text())
root = Path(os.environ["FAKE_HA_ROOT"])
with (root / "requests.jsonl").open("a") as log:
    log.write(json.dumps({"method": method, "path": path, "payload": payload}) + "\n")
entries = [
    {"domain": "mqtt", "entry_id": "mqtt-original"},
    {"domain": "matter", "entry_id": "matter-original"},
    {"domain": "glances", "entry_id": "glances-original"},
]
if (root / "glances-created").exists():
    entries.append({"domain": "glances", "entry_id": "glances-replacement"})
if path == "api/config":
    result = {"version": "2026.10.2", "config_dir": os.environ.get("FAKE_CONFIG_DIR", "/var/lib/hass")}
elif path == "api/config/config_entries/entry":
    result = entries
elif path == "api/config/config_entries/flow":
    handler = payload["handler"]
    assert payload == ({"handler": "mqtt", "entry_id": "mqtt-original"} if handler == "mqtt" else {"handler": handler})
    result = {"type": "form", "flow_id": "FLOW_" + handler, "step_id": {"mqtt": "broker", "matter": "manual", "glances": "user"}[handler]}
elif path.startswith("api/config/config_entries/flow/FLOW_"):
    handler = path.rsplit("_", 1)[1]
    if method == "DELETE":
        result = {}
    elif handler == os.environ.get("FAKE_FAIL_INTEGRATION"):
        result = {"type": "form", "flow_id": "FLOW_" + handler, "errors": {"base": "NEVER_PRINT_PRIVATE_ERROR"}}
    elif handler == "mqtt":
        assert payload == {"broker": "127.0.0.1", "port": 1883, "protocol": "5", "username": "native", "password": "NEVER_PRINT_PASSWORD", "other_settings": {"set_ca_cert": "off", "set_client_cert": False, "transport": "tcp"}}
        result = {"type": "abort", "reason": "reconfigure_successful"}
    elif handler == "matter":
        assert payload == {"url": "ws://127.0.0.1:5580/ws"}
        result = {"type": "abort", "reason": "reconfiguration_successful"}
    else:
        assert payload == {"host": "127.0.0.1", "port": 61208, "ssl": False, "verify_ssl": False}
        (root / "glances-created").touch()
        result = {"type": "create_entry", "result": {"entry_id": "glances-replacement"}}
else:
    raise AssertionError("Unexpected request")
if "--output" in args:
    Path(args[args.index("--output") + 1]).write_text(json.dumps(result))
else:
    print(json.dumps(result))
"""


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.snapshot = self.root / "snapshot"
        (self.snapshot / ".storage").mkdir(parents=True)
        (self.snapshot / ".HA_VERSION").write_text("2026.10.2\n")
        self.storage(
            "core.config_entries",
            {
                "entries": [
                    {
                        "entry_id": "mqtt-original",
                        "domain": "mqtt",
                        "data": {"password": "NEVER_COPY_SNAPSHOT_SECRET"},
                    },
                    {"entry_id": "matter-original", "domain": "matter"},
                    {
                        "entry_id": "glances-original",
                        "domain": "glances",
                        "data": {"host": "a0d7b954-glances"},
                    },
                ]
            },
        )
        self.storage(
            "core.entity_registry",
            {
                "entities": [
                    {
                        "entity_id": "media_player.voice",
                        "device_id": "room-device",
                        "platform": "esphome",
                        "disabled_by": None,
                    },
                    {
                        "entity_id": "sensor.old_cpu",
                        "platform": "glances",
                        "config_entry_id": "glances-original",
                        "unique_id": "glances-original--cpu_use_percent",
                    },
                ]
            },
        )
        self.storage(
            "core.restore_state",
            [
                {
                    "state": {
                        "entity_id": "media_player.voice",
                        "attributes": {"supported_features": 4},
                    }
                }
            ],
        )
        self.declarations = self.root / "declarations.json"
        self.declarations.write_text(
            json.dumps(
                {
                    "devices": {
                        "roomVoiceTarget": "room-device",
                        "kitchenVoiceTarget": "kitchen-device",
                        "reaperWakeTarget": "wake-device",
                    }
                }
            )
        )
        self.mqtt = self.root / "mqtt.json"
        self.mqtt.write_text(
            json.dumps({"username": "native", "password": "NEVER_PRINT_PASSWORD"})
        )
        self.glances = self.root / "glances.json"
        self.glances.write_text("{}")
        self.token = self.root / "token"
        self.token.write_text("NEVER_PRINT_TOKEN")
        self.token.chmod(0o600)
        self.plan = self.root / "plan.json"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = self.bin / "curl"
        fake.write_text(f"#!{sys.executable}\n" + FAKE_CURL)
        fake.chmod(0o700)
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "FAKE_HA_ROOT": str(self.root),
        }
        self.export()

    def storage(self, name, data):
        (self.snapshot / ".storage" / name).write_text(json.dumps({"data": data}))

    def run_driver(self, *args, **env):
        result = subprocess.run(
            [shutil.which("bash"), str(SOURCE), *args],
            env={**self.env, **env},
            text=True,
            capture_output=True,
            check=False,
        )
        for secret in (
            "NEVER_PRINT_PASSWORD",
            "NEVER_PRINT_TOKEN",
            "NEVER_PRINT_PRIVATE_ERROR",
            "NEVER_COPY_SNAPSHOT_SECRET",
        ):
            self.assertNotIn(secret, result.stdout + result.stderr)
        return result

    def export(self, *args):
        result = self.run_driver(
            "--export-plan",
            str(self.snapshot),
            "--declarations",
            str(self.declarations),
            "--mqtt-credentials-file",
            str(self.mqtt),
            "--glances-credentials-file",
            str(self.glances),
            "--output",
            str(self.plan),
            *args,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def apply(self, *args, **env):
        return self.run_driver(
            "--plan",
            str(self.plan),
            "--apply",
            "--token-file",
            str(self.token),
            "--url",
            "http://127.0.0.1:8123",
            *args,
            **env,
        )

    def requests(self):
        path = self.root / "requests.jsonl"
        return (
            [json.loads(line) for line in path.read_text().splitlines()]
            if path.exists()
            else []
        )

    def test_export_has_original_ids_capability_evidence_and_no_credentials(self):
        plan = json.loads(self.plan.read_text())
        self.assertEqual(plan["entries"]["matter"], "matter-original")
        self.assertEqual(
            plan["capability_inventory"][0]["candidates"][0]["supported_features"], 4
        )
        self.assertNotIn("NEVER_COPY_SNAPSHOT_SECRET", self.plan.read_text())
        self.assertEqual(self.plan.stat().st_mode & 0o777, 0o600)

    def test_default_is_offline(self):
        result = self.run_driver("--plan", str(self.plan))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.requests(), [])

    def test_selected_glances_entry_excludes_other_servers_and_keeps_metadata(self):
        self.plan.unlink()
        path = self.snapshot / ".storage/core.config_entries"
        entries = json.loads(path.read_text())
        entries["data"]["entries"].append(
            {
                "entry_id": "other-glances",
                "domain": "glances",
                "data": {"host": "core-other-glances"},
            }
        )
        path.write_text(json.dumps(entries))
        path = self.snapshot / ".storage/core.entity_registry"
        registry = json.loads(path.read_text())
        registry["data"]["entities"][1].update(
            {
                "disabled_by": "user",
                "area_id": "room",
                "labels": ["retained"],
                "options": {"sensor": {"display_precision": 1}},
            }
        )
        registry["data"]["entities"].append(
            {
                "entity_id": "sensor.other_cpu",
                "platform": "glances",
                "config_entry_id": "other-glances",
                "unique_id": "other-glances--cpu_use_percent",
            }
        )
        path.write_text(json.dumps(registry))
        self.export("--glances-entry-id", "glances-original")
        entities = json.loads(self.plan.read_text())["glances_entity_names"]
        self.assertEqual(len(entities), 1)
        self.assertEqual(entities[0]["entity_id"], "sensor.old_cpu")
        self.assertEqual(entities[0]["disabled_by"], "user")
        self.assertEqual(entities[0]["labels"], ["retained"])
        self.assertEqual(entities[0]["options"], {"sensor": {"display_precision": 1}})

    def test_inherited_shell_tracing_cannot_print_runtime_credentials(self):
        result = self.apply(SHELLOPTS="xtrace")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_exact_supported_flows_retain_originals_and_record_replacement(self):
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        requests = self.requests()
        self.assertEqual(len([r for r in requests if r["method"] == "POST"]), 6)
        self.assertFalse(
            any("/services/" in r["path"] or r["method"] == "DELETE" for r in requests)
        )
        receipt = json.loads(Path(str(self.plan) + ".receipt.json").read_text())
        self.assertEqual(receipt["applied"]["mqtt"]["entry_id"], "mqtt-original")
        self.assertEqual(receipt["applied"]["matter"]["entry_id"], "matter-original")
        self.assertEqual(
            receipt["applied"]["glances"]["entry_id"], "glances-replacement"
        )
        result = self.apply("--integration", "glances")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([r for r in self.requests() if r["method"] == "POST"]), 6)

    def test_apply_refuses_remote_url_and_live_haos(self):
        result = self.apply("--url", "http://homeassistant.glib.sh:8123")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.requests(), [])
        result = self.apply(FAKE_CONFIG_DIR="/config")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([r["method"] for r in self.requests()], ["GET"])

    def test_flow_failure_cancels_only_pending_flow_and_records_partial_success(self):
        result = self.apply(FAKE_FAIL_INTEGRATION="matter")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            self.requests()[-1]["path"], "api/config/config_entries/flow/FLOW_matter"
        )
        self.assertEqual(self.requests()[-1]["method"], "DELETE")
        receipt = json.loads(Path(str(self.plan) + ".receipt.json").read_text())
        self.assertEqual(set(receipt["applied"]), {"mqtt"})

    def test_missing_entry_cannot_create_replacement(self):
        plan = json.loads(self.plan.read_text())
        plan["entries"]["mqtt"] = "not-the-original"
        self.plan.write_text(json.dumps(plan))
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(r["method"] == "POST" for r in self.requests()))


if __name__ == "__main__":
    unittest.main()
