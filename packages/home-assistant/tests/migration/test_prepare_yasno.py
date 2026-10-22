"""Offline Yasno bootstrap requires explicit address and registry evidence."""

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
    else Path(__file__).parents[2] / "migration/prepare-yasno.sh"
)
BINDINGS = {
    "electricity": "sensor.yasno_power",
    "next_connectivity": "sensor.yasno_next_power",
    "next_planned_outage": "sensor.yasno_next_planned_outage",
    "next_probable_outage": "sensor.yasno_next_probable_outage",
    "schedule_updated_on": "sensor.yasno_schedule_updated_on",
    "status_today": "sensor.yasno_status_today",
    "status_tomorrow": "sensor.yasno_status_tomorrow",
    "planned_outages": "calendar.yasno_planned_outages",
    "probable_outages": "calendar.yasno_probable_outages",
}


class PrepareYasnoTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.snapshot = self.root / "snapshot"
        (self.snapshot / ".storage").mkdir(parents=True)
        self.entries = [
            {
                "entry_id": "original",
                "domain": "yasno_outages",
                "data": {
                    "region": "fixture-region",
                    "provider": "fixture-provider",
                    "group": "1.1",
                    "filter_probable": True,
                },
                "options": {
                    "filter_probable": False,
                    "status_all_day_events": False,
                    "scan_interval": 20,
                },
            }
        ]
        self.registry = [
            {
                "entity_id": entity,
                "platform": "yasno_outages",
                "config_entry_id": "original",
                "unique_id": f"original-1.1-{key}",
            }
            for key, entity in BINDINGS.items()
        ]
        self.write_snapshot()
        self.address = self.write(
            "address.json",
            {"region_id": 1, "provider_id": 2, "street_id": 3, "house_id": 4},
        )
        self.regions = self.write(
            "regions.json",
            [
                {
                    "id": 1,
                    "value": "fixture-region",
                    "dsos": [{"id": 2, "name": "fixture-provider"}],
                }
            ],
        )
        self.group = self.write("official-group.json", {"group": 1, "subgroup": 1})
        self.secrets = self.root / "old-secrets.yaml"
        self.secrets.write_text(
            "soundbar_api_key: NEVER_PRINT_SOUND_BAR_SECRET\nother:\n  retained: false\n"
        )
        self.output = self.root / "new-secrets.yaml"
        self.plan = self.root / "plan.json"

    def write(self, name, data):
        path = self.root / name
        path.write_text(json.dumps(data))
        return path

    def write_snapshot(self):
        (self.snapshot / ".storage/core.config_entries").write_text(
            json.dumps({"data": {"entries": self.entries}})
        )
        (self.snapshot / ".storage/core.entity_registry").write_text(
            json.dumps({"data": {"entities": self.registry}})
        )

    def run_driver(self):
        result = subprocess.run(
            [
                shutil.which("bash"),
                str(SOURCE),
                "--snapshot",
                str(self.snapshot),
                "--address-file",
                str(self.address),
                "--regions-file",
                str(self.regions),
                "--official-group-file",
                str(self.group),
                "--existing-secrets",
                str(self.secrets),
                "--output",
                str(self.output),
                "--plan",
                str(self.plan),
            ],
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotIn("NEVER_PRINT", result.stdout + result.stderr)
        return result

    def test_preserves_unknown_secrets_and_false_preferences(self):
        before = self.secrets.read_bytes()
        result = self.run_driver()
        self.assertEqual(result.returncode, 0, result.stderr)
        merged = json.loads(
            subprocess.check_output(["yq", "-o=json", ".", str(self.output)])
        )
        self.assertEqual(merged["soundbar_api_key"], "NEVER_PRINT_SOUND_BAR_SECRET")
        self.assertEqual(merged["other"], {"retained": False})
        guard = merged["yasno_address_guard"]
        self.assertEqual(guard["bindings"], BINDINGS)
        self.assertFalse(guard["settings"]["filter_probable"])
        self.assertFalse(guard["settings"]["status_all_day_events"])
        self.assertEqual(guard["settings"]["scan_interval"], 20)
        self.assertEqual(self.secrets.read_bytes(), before)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)

    def test_legacy_entity_names_produce_exact_plan_and_no_secret(self):
        self.registry[0]["entity_id"] = "sensor.old_group_power"
        self.write_snapshot()
        result = self.run_driver()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.output.exists())
        plan = json.loads(self.plan.read_text())
        rename = next(
            row for row in plan["entity_name_map"] if row["key"] == "electricity"
        )
        self.assertEqual(
            (rename["old_entity_id"], rename["new_entity_id"]),
            ("sensor.old_group_power", "sensor.yasno_power"),
        )

    def test_official_group_mismatch_cannot_bootstrap(self):
        self.group.write_text('{"group":2,"subgroup":1}')
        self.assertNotEqual(self.run_driver().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_numeric_address_ids_and_region_provider_ownership_are_required(self):
        self.address.write_text(
            '{"region_id":true,"provider_id":2,"street_id":3,"house_id":4}'
        )
        self.assertNotEqual(self.run_driver().returncode, 0)
        self.address.write_text(
            '{"region_id":1,"provider_id":99,"street_id":3,"house_id":4}'
        )
        self.assertNotEqual(self.run_driver().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_missing_unique_id_cannot_fabricate_binding(self):
        self.registry.pop()
        self.write_snapshot()
        self.assertNotEqual(self.run_driver().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_disabled_binding_and_conflicting_identity_are_not_renamed(self):
        self.registry[0]["entity_id"] = "sensor.legacy"
        self.registry[0]["disabled_by"] = "user"
        self.registry.append(
            {
                "entity_id": "sensor.yasno_power",
                "unique_id": "unrelated",
                "platform": "other",
            }
        )
        self.write_snapshot()
        self.assertNotEqual(self.run_driver().returncode, 0)
        plan = json.loads(self.plan.read_text())
        self.assertTrue(plan["has_name_conflict"])
        self.assertTrue(plan["has_disabled_binding"])
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
