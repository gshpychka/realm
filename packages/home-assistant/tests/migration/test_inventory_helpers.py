"""Official lookup selections and Glances identity matching without network."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

COLLECT = Path(sys.argv.pop(1))
GLANCES = Path(sys.argv.pop(1))
FAKE_CURL = r"""
import json, sys
from pathlib import Path
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith("https://"))
assert url.startswith("https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/")
assert "--get" in args and "--proto" in args and "--max-redirs" in args
endpoint = url.rsplit("/", 1)[1]
params = {}
for index, arg in enumerate(args):
    if arg == "--data-urlencode":
        value = args[index + 1]
        if value.startswith("query@"):
            params["query"] = Path(value[6:]).read_text()
        else:
            key, value = value.split("=", 1)
            params[key] = value
if endpoint != "regions":
    assert params["regionId"] == "1" and params["dsoId"] == "2"
if endpoint == "regions":
    data = [{"id": 1, "value": "fixture-region", "dsos": [{"id": 2, "name": "fixture-provider"}]}]
elif endpoint == "streets":
    assert params["query"] == "NEVER_PRINT_STREET"
    data = [{"id": 3, "value": "NEVER_PRINT_STREET"}]
elif endpoint == "houses":
    assert params["streetId"] == "3" and params["query"] == "NEVER_PRINT_HOUSE"
    data = [{"id": 4, "value": "NEVER_PRINT_HOUSE"}]
elif endpoint == "group":
    assert params["streetId"] == "3" and params["houseId"] == "4"
    data = {"group": 1, "subgroup": 1}
else:
    raise AssertionError("Unexpected endpoint")
Path(args[args.index("--output") + 1]).write_text(json.dumps(data))
"""


class InventoryHelpersTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.snapshot = self.root / "snapshot"
        (self.snapshot / ".storage").mkdir(parents=True)
        self.entries = [
            {
                "entry_id": "yasno-original",
                "domain": "yasno_outages",
                "data": {
                    "region": "fixture-region",
                    "provider": "fixture-provider",
                    "street_id": 3,
                    "house_id": 4,
                },
            }
        ]
        self.save_entries()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake = self.bin / "curl"
        fake.write_text(f"#!{sys.executable}\n" + FAKE_CURL)
        fake.chmod(0o700)
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
        }
        self.evidence = self.root / "evidence"
        self.queries = self.write(
            "queries.json",
            {"street_query": "NEVER_PRINT_STREET", "house_query": "NEVER_PRINT_HOUSE"},
        )
        self.selection = self.root / "selection.json"

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value))
        return path

    def save_entries(self):
        (self.snapshot / ".storage/core.config_entries").write_text(
            json.dumps({"data": {"entries": self.entries}})
        )

    def driver(self, script, *args):
        result = subprocess.run(
            [shutil.which("bash"), str(script), *map(str, args)],
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotIn("NEVER_PRINT", result.stdout + result.stderr)
        return result

    def collect(self, *args):
        return self.driver(
            COLLECT, "--snapshot", self.snapshot, "--output", self.evidence, *args
        )

    def test_existing_address_collects_exact_official_evidence_without_queries(self):
        before = (self.snapshot / ".storage/core.config_entries").read_bytes()
        result = self.collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads((self.evidence / "yasno-address.json").read_text()),
            {"region_id": 1, "provider_id": 2, "street_id": 3, "house_id": 4},
        )
        self.assertEqual(
            json.loads((self.evidence / "yasno-official-group.json").read_text()),
            {"group": 1, "subgroup": 1},
        )
        self.assertEqual(self.evidence.stat().st_mode & 0o777, 0o700)
        self.assertEqual(
            (self.snapshot / ".storage/core.config_entries").read_bytes(), before
        )

    def group_only(self):
        self.entries[0]["data"].pop("street_id")
        self.entries[0]["data"].pop("house_id")
        self.save_entries()

    def test_group_only_requires_two_explicit_official_selections(self):
        self.group_only()
        result = self.collect("--query-file", self.queries)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(
            json.loads((self.evidence / "selection-required.json").read_text())[
                "field"
            ],
            "street_id",
        )
        self.selection.write_text('{"street_id":3}')
        result = self.collect(
            "--query-file", self.queries, "--selection-file", self.selection, "--resume"
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(
            json.loads((self.evidence / "selection-required.json").read_text())[
                "field"
            ],
            "house_id",
        )
        self.selection.write_text('{"street_id":3,"house_id":4}')
        result = self.collect(
            "--query-file", self.queries, "--selection-file", self.selection, "--resume"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.evidence / "selection-required.json").exists())

    def test_selection_not_present_in_official_candidates_is_rejected(self):
        self.group_only()
        self.selection.write_text('{"street_id":999,"house_id":4}')
        result = self.collect(
            "--query-file", self.queries, "--selection-file", self.selection
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.evidence / "yasno-address.json").exists())

    def test_resume_cannot_switch_to_another_entry(self):
        self.assertEqual(self.collect().returncode, 0)
        self.entries[0]["entry_id"] = "other-entry"
        self.save_entries()
        self.assertNotEqual(self.collect("--resume").returncode, 0)

    def mapping_fixture(self):
        plan = self.write(
            "plan.json",
            {
                "entries": {"glances": "old"},
                "glances_entity_names": [
                    {
                        "entity_id": "sensor.old_cpu",
                        "unique_id": "old--cpu",
                        "config_entry_id": "old",
                        "labels": ["retained"],
                        "disabled_by": "user",
                    }
                ],
            },
        )
        receipt = self.write(
            "receipt.json",
            {
                "plan_sha256": hashlib.sha256(plan.read_bytes()).hexdigest(),
                "applied": {"glances": {"entry_id": "new"}},
            },
        )
        registry = {
            "data": {
                "entities": [
                    {
                        "platform": "glances",
                        "entity_id": "sensor.new_cpu",
                        "config_entry_id": "new",
                        "unique_id": "new--cpu",
                    },
                    {
                        "platform": "glances",
                        "entity_id": "sensor.unrelated",
                        "config_entry_id": "unrelated",
                        "unique_id": "unrelated--cpu",
                    },
                ]
            }
        }
        (self.snapshot / ".storage/core.entity_registry").write_text(
            json.dumps(registry)
        )
        return plan, receipt, registry

    def map(self, plan, receipt):
        return self.driver(
            GLANCES,
            "--plan",
            plan,
            "--receipt",
            receipt,
            "--snapshot",
            self.snapshot,
            "--output",
            self.root / "mapping.json",
        )

    def test_glances_map_uses_exact_suffix_and_retains_metadata(self):
        plan, receipt, _ = self.mapping_fixture()
        result = self.map(plan, receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        mapping = json.loads((self.root / "mapping.json").read_text())
        self.assertEqual(mapping[0]["replacement_entity_id"], "sensor.new_cpu")
        self.assertEqual(mapping[0]["target_entity_id"], "sensor.old_cpu")
        self.assertEqual(mapping[0]["old_metadata"]["labels"], ["retained"])
        self.assertEqual(mapping[0]["old_metadata"]["disabled_by"], "user")

    def test_glances_missing_metric_requires_explicit_decision(self):
        plan, receipt, registry = self.mapping_fixture()
        registry["data"]["entities"].pop(0)
        (self.snapshot / ".storage/core.entity_registry").write_text(
            json.dumps(registry)
        )
        result = self.map(plan, receipt)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(
            json.loads((self.root / "mapping.json").read_text())[0]["status"],
            "requires_metric_decision",
        )

    def test_glances_map_rejects_receipt_for_another_plan(self):
        plan, receipt, _ = self.mapping_fixture()
        plan.write_text(plan.read_text() + "\n")
        self.assertNotEqual(self.map(plan, receipt).returncode, 0)
        self.assertFalse((self.root / "mapping.json").exists())


if __name__ == "__main__":
    unittest.main()
