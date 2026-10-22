"""Migration checks exercise private snapshot failures without private fixtures."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = (
    Path(sys.argv.pop(1))
    if len(sys.argv) > 1
    else Path(__file__).parents[2] / "migration/preflight.py"
)
spec = importlib.util.spec_from_file_location("preflight", SOURCE)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.config = self.root / "hass"
        (self.config / ".storage").mkdir(parents=True)
        (self.config / ".ssh").mkdir()
        for name in ("home-assistant_v2.db", ".ssh/outbound_key", ".ssh/known_hosts"):
            (self.config / name).touch()
        self.write("auth", {"users": [{}], "refresh_tokens": [{}]})
        self.write(
            "core.config_entries",
            {"entries": [{"entry_id": "entry", "domain": "mqtt"}]},
        )
        self.write(
            "core.entity_registry",
            {
                "entities": [
                    {
                        "entity_id": "light.bed",
                        "config_entry_id": "entry",
                        "disabled_by": None,
                    }
                ]
            },
        )
        self.write("core.device_registry", {"devices": [{"id": "a" * 32}]})
        self.write("core.area_registry", {"areas": [{"id": "room"}]})
        self.declarations = {
            "configuration": {
                "script": {
                    "wake": {
                        "sequence": [
                            {
                                "action": "light.turn_on",
                                "target": {
                                    "entity_id": "light.bed",
                                    "device_id": "a" * 32,
                                    "area_id": "room",
                                },
                            }
                        ]
                    }
                },
            },
            "entities": {"light": {"bed": "light.bed", "unused": "light.unused"}},
        }

    def write(self, name, data):
        (self.config / ".storage" / name).write_text(json.dumps({"data": data}))

    def audit(self):
        return preflight.audit(self.config, self.declarations)

    def codes(self):
        return {finding["code"] for finding in self.audit()["findings"]}

    def test_valid_inventory_still_requires_physical_acceptance(self):
        self.assertEqual(self.audit()["status"], "needs-acceptance")
        self.assertEqual(self.codes(), set())
        self.assertTrue(self.audit()["acceptance_required"])

    def test_missing_invalid_and_empty_private_state_are_blockers(self):
        (self.config / ".storage/auth").write_text('{"secret": "NEVER_PRINT"')
        (self.config / "home-assistant_v2.db").unlink()
        report = self.audit()
        self.assertEqual(report["status"], "blocked")
        self.assertTrue(
            {"state-unreadable", "authentication-incomplete", "history-missing"}
            <= self.codes()
        )
        self.assertNotIn("NEVER_PRINT", json.dumps(report))

    def test_missing_targets_and_disabled_integrations_are_blockers(self):
        self.write(
            "core.config_entries",
            {"entries": [{"entry_id": "entry", "disabled_by": "user"}]},
        )
        self.write("core.device_registry", {"devices": []})
        self.write("core.area_registry", {"areas": []})
        self.assertTrue(
            {"entity-disabled", "device-missing", "area-missing"} <= self.codes()
        )

    def test_native_yaml_entities_need_no_registry(self):
        self.declarations["configuration"]["script"]["wake"]["sequence"].append(
            {"action": "script.wake", "target": {"entity_id": "script.wake"}}
        )
        self.assertEqual(self.codes(), set())

    def test_missing_external_entity_and_restore_state_evidence(self):
        self.write("core.entity_registry", {"entities": []})
        self.assertIn("entity-missing", self.codes())
        self.write("core.restore_state", [{"state": {"entity_id": "light.bed"}}])
        self.assertNotIn("entity-missing", self.codes())

    def test_supervisor_urls_and_bare_hosts_are_redacted(self):
        for host in (
            "http://supervisor/NEVER_PRINT",
            "core-mosquitto",
            "ws://core_matter_server:5580/ws",
            "a0d7b954-mqtt",
            "http://user:NEVER_PRINT@core-mosquitto:1883",
        ):
            with self.subTest(host=host):
                self.write(
                    "core.config_entries",
                    {
                        "entries": [
                            {
                                "domain": "mqtt",
                                "data": {"host": host, "password": "NEVER_PRINT"},
                            }
                        ]
                    },
                )
                report = self.audit()
                self.assertIn("supervisor-endpoint", self.codes())
                self.assertNotIn("NEVER_PRINT", json.dumps(report))
        self.assertFalse(preflight.supervisor_endpoint("mqtt.glib.sh"))

    def test_restored_identity_requires_matching_unique_id(self):
        self.declarations["configuration"]["automation"] = [
            {"id": "old-id", "alias": "Test"}
        ]
        self.write(
            "core.entity_registry",
            {
                "entities": [
                    {"entity_id": "automation.test", "unique_id": "old-id"},
                    {"entity_id": "light.bed"},
                ]
            },
        )
        self.assertNotIn("identity-review", self.codes())
        self.declarations["configuration"]["automation"][0]["id"] = "replacement-id"
        self.assertIn("identity-review", self.codes())

    def test_registry_scene_rename_breaks_declared_callers(self):
        config = self.declarations["configuration"]
        config["scene"] = [{"id": "123", "name": "Night"}]
        config["script"]["wake"]["sequence"].append(
            {"action": "scene.turn_on", "target": {"entity_id": "scene.night"}}
        )
        self.write(
            "core.entity_registry",
            {
                "entities": [
                    {"entity_id": "light.bed"},
                    {"entity_id": "scene.renamed", "unique_id": "123"},
                ]
            },
        )
        self.assertIn("scene-renamed", self.codes())

    def test_cli_is_read_only_and_returns_failure_without_leaking_values(self):
        declarations = self.root / "declarations.json"
        declarations.write_text(json.dumps(self.declarations))
        self.write(
            "core.config_entries",
            {"entries": [{"data": {"url": "http://supervisor/NEVER_PRINT"}}]},
        )
        before = {p: p.read_bytes() for p in self.config.rglob("*") if p.is_file()}
        result = subprocess.run(
            [
                sys.executable,
                str(SOURCE),
                "--declarations",
                str(declarations),
                str(self.config),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("NEVER_PRINT", result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "blocked")
        self.assertEqual(
            before, {p: p.read_bytes() for p in self.config.rglob("*") if p.is_file()}
        )


if __name__ == "__main__":
    unittest.main()
