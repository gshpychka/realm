"""Exercise fresh-capture drift, safe YAML resolution and bound review ledgers."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

MIGRATION = (
    Path(sys.argv.pop(1)).resolve()
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-")
    else Path(__file__).resolve().parents[2] / "migration"
)


class ConfigDrift(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.snapshot = self.root / "snapshot"
        self.snapshot.mkdir()
        (self.snapshot / ".HA_VERSION").write_text("2026.10.2\n")
        (self.snapshot / ".storage").mkdir()
        (self.snapshot / ".storage/core.config_entries").write_text(
            json.dumps(
                {
                    "data": {
                        "entries": [
                            {
                                "domain": "mqtt",
                                "data": {"password": "PRIVATE_TOKEN_SENTINEL"},
                            }
                        ]
                    }
                }
            )
        )
        self.declarations = self.root / "declarations.json"
        self.counter = 0
        self.declare({})

    def declare(self, config):
        self.declarations.write_text(json.dumps({"configuration": config}))

    def source(self, text):
        (self.snapshot / "configuration.yaml").write_text(text)

    def audit(self, code=0, decisions=None):
        self.counter += 1
        output = self.root / f"report-{self.counter}"
        args = [
            sys.executable,
            str(MIGRATION / "config-drift.py"),
            "--snapshot",
            str(self.snapshot),
            "--declarations",
            str(self.declarations),
            "--output",
            str(output),
        ]
        if decisions is not None:
            args += ["--decisions", str(decisions)]
        before = {
            str(p.relative_to(self.snapshot)): p.read_bytes()
            for p in self.snapshot.rglob("*")
            if p.is_file()
        }
        result = subprocess.run(args, capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertNotIn("PRIVATE_TOKEN_SENTINEL", result.stdout + result.stderr)
        self.assertEqual(
            before,
            {
                str(p.relative_to(self.snapshot)): p.read_bytes()
                for p in self.snapshot.rglob("*")
                if p.is_file()
            },
        )
        if code == 2:
            return output, None
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        for path in output.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("PRIVATE_TOKEN_SENTINEL", (output / "workbook.md").read_text())
        self.assertNotIn("PRIVATE_TOKEN_SENTINEL", (output / "drift.json").read_text())
        return output, json.loads((output / "drift.json").read_text())

    def test_legacy_schema_aliases_secret_symbols_and_order(self):
        self.source("""automation:
  - id: 123
    trigger:
      - platform: state
        entity_id: sensor.example
    condition: []
    action:
      - service: light.turn_on
        data: {service: literal, platform: literal, api_key: !secret example}
script:
  example:
    sequence:
      - choose:
          - conditions: []
            sequence: [{service: light.turn_off}]
scene: [{id: 456, name: Example, entities: {}}]
frontend:
""")
        self.declare(
            {
                "automation": [
                    {
                        "id": "123",
                        "triggers": [
                            {"trigger": "state", "entity_id": "sensor.example"}
                        ],
                        "conditions": [],
                        "actions": [
                            {
                                "action": "light.turn_on",
                                "data": {
                                    "service": "literal",
                                    "platform": "literal",
                                    "api_key": "!secret example",
                                },
                            }
                        ],
                    }
                ],
                "script": {
                    "example": {
                        "sequence": [
                            {
                                "choose": [
                                    {
                                        "conditions": [],
                                        "sequence": [{"action": "light.turn_off"}],
                                    }
                                ]
                            }
                        ]
                    }
                },
                "scene": [{"id": "456", "name": "Example", "entities": {}}],
                "frontend": {},
            }
        )
        _, report = self.audit()
        self.assertEqual(report["status"], "no_yaml_drift")
        self.assertEqual(report["rows"], [])

    def test_add_edit_delete_unknown_script_scene_and_other_config(self):
        self.source("""automation:
  - {id: stable, alias: Live, actions: [{action: light.turn_on, data: {password: PRIVATE_TOKEN_SENTINEL}}]}
  - {id: new_live, actions: []}
script:
  unknown_live_script: {sequence: []}
scene: [{id: scene_live, name: Live, entities: {}}]
http: {trusted_proxies: [PRIVATE_TOKEN_SENTINEL]}
""")
        self.declare(
            {
                "automation": [
                    {"id": "stable", "alias": "Declared", "actions": []},
                    {"id": "branch_only", "actions": []},
                ],
                "script": {"new_branch_script": {"sequence": []}},
                "scene": [{"id": "scene_branch", "entities": {}}],
                "http": {"trusted_proxies": ["other"]},
            }
        )
        output, report = self.audit(code=1)
        rows = {(row["kind"], row["id"]): row for row in report["rows"]}
        self.assertEqual(rows["automation", "stable"]["change"], "changed")
        self.assertIn("/alias", rows["automation", "stable"]["changed_paths"])
        self.assertEqual(rows["automation", "new_live"]["change"], "live_only")
        self.assertEqual(rows["automation", "branch_only"]["change"], "declared_only")
        self.assertIn(("script", "unknown_live_script"), rows)
        self.assertIn(("scene", "scene_live"), rows)
        self.assertIn(("configuration", "http"), rows)
        self.assertIn(
            "PRIVATE_TOKEN_SENTINEL", (output / "source-normalized.json").read_text()
        )
        self.assertNotIn(
            "PRIVATE_TOKEN_SENTINEL", (output / "runtime-inventory.json").read_text()
        )

    def test_recursive_and_all_directory_include_modes(self):
        self.source("""automation main: !include automation.yaml
script: !include_dir_named scripts
scene: !include_dir_merge_list scenes
input_boolean: !include_dir_merge_named helpers
template: !include_dir_list templates
""")
        (self.snapshot / "automation.yaml").write_text(
            "- {id: nested, actions: !include nested-actions.yaml}\n"
        )
        (self.snapshot / "nested-actions.yaml").write_text(
            "- {service: light.turn_on}\n"
        )
        for directory in ("scripts", "scenes/nested", "helpers", "templates"):
            (self.snapshot / directory).mkdir(parents=True)
        (self.snapshot / "scripts/example.yaml").write_text("sequence: []\n")
        (self.snapshot / "scripts/secrets.yaml").write_text(
            "ignored: PRIVATE_TOKEN_SENTINEL\n"
        )
        (self.snapshot / "scenes/nested/one.yaml").write_text(
            "- {id: scene_one, entities: {}}\n"
        )
        (self.snapshot / "helpers/one.yaml").write_text("flag: {name: Flag}\n")
        (self.snapshot / "templates/one.yaml").write_text("sensor: []\n")
        self.declare(
            {
                "automation": [
                    {"id": "nested", "actions": [{"action": "light.turn_on"}]}
                ],
                "script": {"example": {"sequence": []}},
                "scene": [{"id": "scene_one", "entities": {}}],
                "input_boolean": {"flag": {"name": "Flag"}},
                "template": [{"sensor": []}],
            }
        )
        _, report = self.audit()
        self.assertEqual(len(report["source_files"]), 8)
        self.assertRegex(
            report["source_files"]["scripts/secrets.yaml"], r"^[a-f0-9]{64}$"
        )

    def test_unresolved_tags_cycles_traversal_duplicates_and_packages_fail_closed(self):
        cases = [
            (
                "automation: !include missing.yaml\n",
                "include-outside-snapshot-or-missing",
            ),
            ("automation: !include configuration.yaml\n", "include-cycle"),
            (
                "automation: !include ../outside.yaml\n",
                "include-outside-snapshot-or-missing",
            ),
            ("sensor: !unknown PRIVATE_TOKEN_SENTINEL\n", "unsupported-yaml-tag"),
            ("automation: [{id: repeated}, {id: repeated}]\n", "duplicate-identity"),
            ("script: {duplicate: {}, duplicate: {}}\n", "duplicate-yaml-key"),
            ("automation: [{actions: []}]\n", "missing-stable-identity"),
            (
                "homeassistant: {packages: {one: {script: {inside_package: {sequence: []}}}}}\n",
                "package-merge-needs-review",
            ),
        ]
        (self.root / "outside.yaml").write_text("PRIVATE_TOKEN_SENTINEL\n")
        for text, expected in cases:
            with self.subTest(expected=expected):
                self.source(text)
                _, report = self.audit(code=1)
                self.assertIn(expected, [item["code"] for item in report["findings"]])

    def test_aliases_do_not_reorder_actions_or_rewrite_action_data(self):
        self.source(
            "automation: [{id: stable, actions: [{action: first}, {action: second}]}]\n"
        )
        self.declare(
            {
                "automation": [
                    {
                        "id": "stable",
                        "actions": [{"action": "second"}, {"action": "first"}],
                    }
                ]
            }
        )
        _, report = self.audit(code=1)
        self.assertEqual(report["rows"][0]["change"], "changed")

    def ledger(self, output):
        document = json.loads((output / "decisions-template.json").read_text())
        for row in document["decisions"]:
            row.update(
                decision="merge",
                reason="Reviewed intentional branch changes",
                target_file="machines/home-assistant/configuration/example.nix",
                validation="Reviewed exact trace and rebuilt checks",
            )
        for item in document["acknowledgements"]:
            item.update(
                disposition="preserve-runtime",
                reason="Verified dashboard is retained as private runtime state",
                validation="Opened matching dashboard on test instance",
            )
        path = self.root / "decisions.json"
        path.write_text(json.dumps(document))
        path.chmod(0o600)
        return path, document

    def test_bound_decisions_require_evidence_and_reject_state_only_or_stale_input(
        self,
    ):
        self.source("automation: [{id: stable, alias: Live}]\n")
        self.declare({"automation": [{"id": "stable", "alias": "Branch"}]})
        output, _ = self.audit(code=1)
        path, document = self.ledger(output)
        _, accounted = self.audit(decisions=path)
        self.assertEqual(accounted["status"], "accounted")
        self.assertEqual(accounted["unresolved_count"], 0)
        original = json.loads(json.dumps(document))
        for mutation in ("state-only", "missing-validation", "duplicate"):
            changed = json.loads(json.dumps(original))
            if mutation == "state-only":
                changed["decisions"][0]["decision"] = "state-only"
            elif mutation == "missing-validation":
                changed["decisions"][0]["validation"] = ""
            else:
                changed["decisions"].append(changed["decisions"][0])
            path.write_text(json.dumps(changed))
            self.audit(code=2, decisions=path)
        path.write_text(json.dumps(original))
        (self.snapshot / "secrets.yaml").write_text("token: PRIVATE_TOKEN_SENTINEL\n")
        self.audit(code=2, decisions=path)
        output, _ = self.audit(code=1)
        path, _ = self.ledger(output)
        (self.snapshot / "secrets.yaml").write_text("token: rotated-private-value\n")
        self.audit(code=2, decisions=path)
        (self.snapshot / "secrets.yaml").unlink()
        path.write_text(json.dumps(original))
        self.source("automation: [{id: stable, alias: Edited-again}]\n")
        self.audit(code=2, decisions=path)

    def test_inventory_acknowledgements_bound_to_unreferenced_content(self):
        self.source("{}\n")
        (self.snapshot / "unused-dashboard.yaml").write_text("title: Example\n")
        output, report = self.audit(code=1)
        self.assertEqual(
            report["findings"][0]["code"], "unreferenced-yaml-needs-review"
        )
        path, _ = self.ledger(output)
        _, accounted = self.audit(decisions=path)
        self.assertEqual(accounted["status"], "accounted")
        for name in ("blueprints", "pyscript", "python_scripts", "www"):
            directory = self.snapshot / name
            directory.mkdir()
            (directory / "private-source.txt").write_text("PRIVATE_TOKEN_SENTINEL")
        self.audit(code=2, decisions=path)
        output, _ = self.audit(code=1)
        path, _ = self.ledger(output)
        output, _ = self.audit(decisions=path)
        inventory = json.loads((output / "runtime-inventory.json").read_text())
        for name in ("blueprints", "pyscript", "python_scripts", "www"):
            self.assertEqual(inventory["retained_code"][name]["file_count"], 1)
        (self.snapshot / "pyscript/private-source.txt").write_text("changed-code")
        self.audit(code=2, decisions=path)
        output, _ = self.audit(code=1)
        path, _ = self.ledger(output)
        (self.snapshot / "unused-dashboard.yaml").write_text("title: Changed\n")
        self.audit(code=2, decisions=path)

    def test_invalid_output_and_snapshot_inputs(self):
        self.source("{}\n")
        result = subprocess.run(
            [
                sys.executable,
                str(MIGRATION / "config-drift.py"),
                "--snapshot",
                str(self.snapshot),
                "--declarations",
                str(self.declarations),
                "--output",
                str(self.snapshot / "unsafe"),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.snapshot / "unsafe").exists())


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
