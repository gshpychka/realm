"""Exercise ownership boundaries independently of the current source tree."""

import tempfile
import unittest
from pathlib import Path

from check import MACHINE, PACKAGE, check_layout


class LayoutTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for base in (MACHINE, PACKAGE):
            (self.root / base).mkdir(parents=True)

    def write(self, path, source="fixture data\n"):
        path = self.root / path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        return path

    def test_domain_owns_modules_templates_and_assets(self):
        domain = MACHINE / "configuration/weather"
        self.write(domain / "automations.nix", "{ ha, ... }: { }\n")
        self.write(domain / "templates.nix", "{ }\n")
        self.write(domain / "report.jinja", "Forecast: " + "{{" + " temperature }}")
        self.write(domain / "tests/cases.json", "[]\n")
        self.assertEqual(check_layout(self.root), [])

    def test_component_owns_expression_patch_and_tests(self):
        component = PACKAGE / "custom-components/dyson_local"
        self.write(component / "package.nix", "{ }: { }\n")
        self.write(component / "vacuum.patch")
        self.write(component / "tests/check.py", "assert True\n")
        self.assertEqual(check_layout(self.root), [])

    def test_dependency_runtime_owns_its_patch(self):
        dependency = PACKAGE / "core-dependencies/pymodbus"
        self.write(dependency / "default.nix", "{ }: { }\n")
        self.write(dependency / "isolation.patch")
        self.assertEqual(check_layout(self.root), [])

    def test_qa_concern_owns_mixed_implementation_and_fixtures(self):
        concern = PACKAGE / "tests/templates"
        self.write(concern / "check.py", "assert True\n")
        self.write(concern / "constructors.nix", "true\n")
        self.write(concern / "fixtures/report.jinja", "Forecast: " + "{{" + " value }}")
        self.assertEqual(check_layout(self.root), [])

    def test_unowned_buckets_are_rejected(self):
        for path in (
            PACKAGE / "tests/nix/check.nix",
            PACKAGE / "tests/python/check.py",
            PACKAGE / "python/package.nix",
            PACKAGE / "patches/dyson/fix.patch",
            PACKAGE / "custom-components/orphan.patch",
            MACHINE / "configuration/jinja/weather/report.jinja",
        ):
            with self.subTest(path=path):
                file = self.write(path)
                self.assertTrue(check_layout(self.root))
                file.unlink()

    def test_component_assets_require_an_entrypoint(self):
        self.write(PACKAGE / "custom-components/orphan/fix.patch")
        self.assertTrue(check_layout(self.root))

    def test_template_rules_still_apply_within_a_domain(self):
        domain = MACHINE / "configuration/weather"
        file = self.write(domain / "report.jinja", "{{" + " trigger.id }}")
        self.assertIn(
            "simple references belong in template.ref", check_layout(self.root)[0]
        )
        file.unlink()
        self.write(
            domain / "templates.nix", 'source = "' + "{{" + ' value | lower }}";'
        )
        self.assertIn(
            "Jinja programs belong in .jinja files", check_layout(self.root)[0]
        )


if __name__ == "__main__":
    unittest.main()
