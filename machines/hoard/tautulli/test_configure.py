"""configure.py's credential adoption rule: a differing live credential is kept until adopted."""

import tempfile
import unittest
from pathlib import Path

import configure

DESIRED = {
    "settings": {},
    "secrets": [{"section": "PMS", "key": "pms_token", "credential": "plex"}],
}


class AdoptionTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.credentials = Path(directory.name)
        (self.credentials / "plex").write_text("sops-token\n")

    def converge(self, live_token, adopted=()):
        config = {"PMS": {"pms_token": live_token}}
        _, adopted, outcomes = configure.converge(
            config, DESIRED, self.credentials, adopted
        )
        return config["PMS"]["pms_token"], outcomes["plex"], adopted

    def test_a_differing_live_credential_is_kept_until_adopted(self):
        self.assertEqual(self.converge("live-token"), ("live-token", "mismatch", set()))
        self.assertEqual(self.converge(""), ("sops-token", "fill", {"plex"}))
        self.assertEqual(
            self.converge("live-token", ["plex"]), ("sops-token", "rotate", {"plex"})
        )


if __name__ == "__main__":
    unittest.main()
