"""Offline tests for configure.py on synthetic config.ini and database files.

usage: test_configure.py <schema.json> <configobj dir>
"""

import contextlib
import io
import json
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from pathlib import Path

import configure

SCHEMA = json.loads(Path(sys.argv[1]).read_text())
CONFIGOBJ = Path(sys.argv[2])
del sys.argv[1:]

SECRETS = {"api": "synthetic-api-key-0123456789abcd", "plex": "synthetic-plex-token-xx"}

LIVE_INI = """\
[General]
http_port = 8181
http_root = ""
home_sections = current_activity, watch_stats
first_run_complete = 1
api_key = synthetic-api-key-0123456789abcd
check_github = 0
[[get_file_sizes_hold]]
section_ids = ,
rating_keys = ,
[PMS]
pms_identifier = synthetic-machine-identifier
pms_token = synthetic-plex-token-xx
pms_port = 32400
[Advanced]
config_version = 22
"""

DESIRED = {
    "settings": {
        "General": {
            "http_port": 8181,
            "http_root": "",
            "home_sections": ["current_activity", "watch_stats"],
            "check_github": False,
        },
        "PMS": {"pms_port": 32400},
    },
    "secrets": [
        {"section": "General", "key": "api_key", "credential": "api"},
        {"section": "PMS", "key": "pms_token", "credential": "plex"},
    ],
}


class ConfigureTest(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.data = root / "plexpy"
        self.data.mkdir(mode=0o755)
        self.data.chmod(0o755)
        self.config = self.data / "config.ini"
        self.config.write_text(LIVE_INI)
        self.config.chmod(0o644)
        (self.data / "logs").mkdir(mode=0o755)
        (self.data / "logs" / "tautulli.log").write_text("log\n")
        (self.data / "logs" / "tautulli.log").chmod(0o644)
        database = sqlite3.connect(self.data / "tautulli.db")
        with database:
            database.execute("PRAGMA journal_mode=WAL")
            database.execute(
                "CREATE TABLE session_history (id INTEGER PRIMARY KEY, user TEXT)"
            )
            database.executemany(
                "INSERT INTO session_history (user) VALUES (?)", [("a",), ("b",)]
            )
        database.close()
        (self.data / "tautulli.db").chmod(0o644)
        self.credentials = root / "credentials"
        self.credentials.mkdir()
        self.write_secrets(SECRETS)
        self.output = io.StringIO()

    def write_secrets(self, secrets):
        for name, value in secrets.items():
            (self.credentials / name).write_text(value + "\n")

    def run_configure(self, desired=DESIRED):
        configure.check(desired, SCHEMA)
        with contextlib.redirect_stdout(self.output):
            configure.apply(
                desired, CONFIGOBJ, self.data, self.config, self.credentials
            )

    def state(self):
        return json.loads((self.data / configure.STATE_FILE).read_text())

    def snapshots(self):
        return sorted((self.data / "backups").glob("pre-declarative-*"))

    def assert_no_secret_output(self):
        for value in SECRETS.values():
            self.assertNotIn(value, self.output.getvalue())

    def test_converged_config_is_not_rewritten_twice(self):
        before = self.config.read_bytes()
        self.run_configure()
        self.run_configure()
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(self.state(), {"adopted": ["api", "plex"], "mismatched": []})
        self.assertEqual(self.output.getvalue().count("already converged"), 2)
        self.assertEqual(len(self.snapshots()), 1)
        self.assert_no_secret_output()

    def test_snapshot_preserves_config_and_history(self):
        self.run_configure()
        (snapshot,) = self.snapshots()
        self.assertEqual((snapshot / "config.ini").read_text(), LIVE_INI)
        copy = sqlite3.connect(snapshot / "tautulli.db")
        self.assertEqual(
            copy.execute("SELECT user FROM session_history").fetchall(),
            [("a",), ("b",)],
        )
        copy.close()
        for path in snapshot.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        live = sqlite3.connect(self.data / "tautulli.db")
        self.assertEqual(
            live.execute("SELECT count(*) FROM session_history").fetchone(), (2,)
        )

    def test_permissions_are_restricted(self):
        self.run_configure()
        for path in [self.data, *self.data.rglob("*")]:
            self.assertFalse(path.stat().st_mode & 0o077, path)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)

    def test_drift_is_corrected_and_unmanaged_keys_survive(self):
        self.config.write_text(
            LIVE_INI.replace("http_port = 8181", "http_port = 9999").replace(
                "home_sections = current_activity, watch_stats",
                "home_sections = watch_stats",
            )
        )
        self.run_configure()
        text = self.config.read_text()
        self.assertIn("http_port = 8181", text)
        self.assertIn("home_sections = current_activity, watch_stats", text)
        for kept in (
            "first_run_complete = 1",
            "pms_identifier = synthetic-machine-identifier",
            "config_version = 22",
            "[[get_file_sizes_hold]]",
        ):
            self.assertIn(kept, text)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        written = self.config.read_bytes()
        self.run_configure()
        self.assertEqual(self.config.read_bytes(), written)

    def test_empty_secret_is_filled(self):
        self.config.write_text(
            LIVE_INI.replace("pms_token = synthetic-plex-token-xx", 'pms_token = ""')
        )
        self.run_configure()
        self.assertIn("pms_token = synthetic-plex-token-xx", self.config.read_text())
        self.assertIn("plex", self.state()["adopted"])
        self.assert_no_secret_output()

    def test_differing_secret_is_not_rotated_on_adoption(self):
        self.write_secrets({"plex": "another-synthetic-token"})
        before = self.config.read_bytes()
        self.run_configure()
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(self.state(), {"adopted": ["api"], "mismatched": ["plex"]})
        self.assertIn("kept the live value", self.output.getvalue())
        self.assertNotIn("another-synthetic-token", self.output.getvalue())
        # restoring the matching value clears the mismatch
        self.write_secrets(SECRETS)
        self.run_configure()
        self.assertEqual(self.state(), {"adopted": ["api", "plex"], "mismatched": []})

    def test_adopted_secret_follows_sops(self):
        self.run_configure()
        self.write_secrets({"plex": "rotated-synthetic-token"})
        self.run_configure()
        self.assertIn("pms_token = rotated-synthetic-token", self.config.read_text())
        self.assertNotIn("rotated-synthetic-token", self.output.getvalue())

    def test_missing_config_is_created(self):
        self.config.unlink()
        self.run_configure()
        text = self.config.read_text()
        self.assertIn("http_port = 8181", text)
        self.assertIn("api_key = synthetic-api-key-0123456789abcd", text)

    def test_check_rejects_unknown_or_mistyped_keys(self):
        for settings in (
            {"General": {"no_such_key": 1}},
            {"PMS": {"http_port": 1}},
            {"General": {"home_sections": "current_activity"}},
            {"General": {"http_root": 1}},
        ):
            with self.assertRaises(SystemExit):
                configure.check({"settings": settings, "secrets": []}, SCHEMA)
        with self.assertRaises(SystemExit):
            configure.check(
                {
                    "settings": {"General": {"api_key": ""}},
                    "secrets": [
                        {"section": "General", "key": "api_key", "credential": "api"}
                    ],
                },
                SCHEMA,
            )

    def run_preview(self):
        with contextlib.redirect_stdout(self.output):
            return configure.preview(
                DESIRED, CONFIGOBJ, self.data, self.config, self.credentials
            )

    def assert_untouched(self, before):
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o644)
        self.assertEqual(self.snapshots(), [])

    def test_preview_of_matching_credentials_passes_and_writes_nothing(self):
        before = self.config.read_bytes()
        self.assertTrue(self.run_preview())
        self.assert_untouched(before)
        self.assertFalse((self.data / configure.STATE_FILE).exists())
        self.assertIn("credential plex: match", self.output.getvalue())
        self.assertIn("would update nothing", self.output.getvalue())
        self.assert_no_secret_output()

    def test_preview_fails_on_a_differing_unadopted_credential(self):
        self.write_secrets({"plex": "another-synthetic-token"})
        before = self.config.read_bytes()
        self.assertFalse(self.run_preview())
        self.assert_untouched(before)
        self.assertIn("credential plex: mismatch", self.output.getvalue())
        self.assertNotIn("another-synthetic-token", self.output.getvalue())

    def test_preview_fails_before_an_adopted_credential_is_rotated(self):
        self.run_configure()
        self.write_secrets({"plex": "rotated-synthetic-token"})
        before, state = self.config.read_bytes(), self.state()
        self.output = io.StringIO()
        self.assertFalse(self.run_preview())
        self.assertEqual(self.config.read_bytes(), before)
        self.assertEqual(self.state(), state)
        self.assertIn("credential plex: rotate", self.output.getvalue())
        self.assertIn("would update PMS.pms_token", self.output.getvalue())
        self.assertNotIn("rotated-synthetic-token", self.output.getvalue())

    def test_preview_allows_filling_an_empty_value(self):
        self.config.write_text(
            LIVE_INI.replace("pms_token = synthetic-plex-token-xx", 'pms_token = ""')
        )
        self.assertTrue(self.run_preview())
        self.assertIn("credential plex: fill", self.output.getvalue())
        self.assertIn('pms_token = ""', self.config.read_text())


if __name__ == "__main__":
    os.umask(0o022)
    unittest.main(verbosity=2)
