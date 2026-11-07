"""Tests of the arr-sync rules a run's own output wouldn't show broken: live secrets and
the login kept, secrets redacted, providers created without a test message or a list sync.

usage: arr-sync-test.py <dir holding arr_sync.py>
"""

import base64
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, sys.argv.pop(1))
import arr_sync  # noqa: E402

TOKEN = "synthetic-bot-token"


class Api:
    """The app's GET responses by path; planning sends nothing else."""

    def __init__(self, responses):
        self.responses = responses

    def get(self, path):
        return self.responses[path]


class Stored:
    """The app's database: provider settings by (kind, id, field)."""

    def __init__(self, values=None):
        self.values = values or {}

    def get(self, kind, resource_id, field):
        return self.values.get((kind, resource_id, field))


def telegram(resource_id=None, token=""):
    resource = {
        "name": "Telegram",
        "implementation": "Telegram",
        "onGrab": False,
        "onDownload": False,
        "fields": [{"name": "botToken", "value": token, "privacy": "apiKey"}],
    }
    if resource_id is not None:
        resource["id"] = resource_id
    return resource


def plex_list(resource_id=None, enabled=False):
    resource = {
        "name": "Watchlist",
        "implementation": "PlexImport",
        "enabled": enabled,
        "enableAuto": enabled,
        "fields": [],
    }
    if resource_id is not None:
        resource["id"] = resource_id
    return resource


class PlanTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.token_file = os.path.join(directory.name, "token")
        with open(self.token_file, "w") as handle:
            handle.write(TOKEN)

    def plan(self, kind, schema, live, spec, stored=None):
        plan = arr_sync.Plan()
        api = Api({f"/{kind}/schema": [schema], f"/{kind}": live})
        arr_sync.plan_providers(api, plan, stored or Stored(), kind, [spec])
        return plan

    def test_a_live_secret_is_filled_when_empty_and_never_overwritten(self):
        spec = {
            "name": "Telegram",
            "implementation": "Telegram",
            "secretFields": {"botToken": self.token_file},
        }
        stored = {("notification", 1, "botToken"): "another-live-token"}
        plan = self.plan(
            "notification",
            telegram(),
            [telegram(1, arr_sync.MASK)],
            spec,
            Stored(stored),
        )
        self.assertEqual(plan.writes, [])
        self.assertEqual(len(plan.mismatches), 1)

        stored = {("notification", 1, "botToken"): TOKEN}
        plan = self.plan(
            "notification",
            telegram(),
            [telegram(1, arr_sync.MASK)],
            spec,
            Stored(stored),
        )
        self.assertEqual((plan.writes, plan.mismatches), ([], []))

        plan = self.plan("notification", telegram(), [telegram(1, "")], spec)
        (write,) = plan.writes
        self.assertEqual(write["body"]["fields"][0]["value"], TOKEN)

    def test_a_notification_is_created_with_its_events_off_then_given_them(self):
        spec = {
            "name": "Telegram",
            "implementation": "Telegram",
            "properties": {"onGrab": True},
        }
        (write,) = self.plan("notification", telegram(), [], spec).writes
        self.assertEqual(write["method"], "POST")
        self.assertFalse(write["body"]["onGrab"])
        self.assertTrue(write["then"]["onGrab"])
        self.assertEqual(write["query"], {"forceSave": "true"})

    def test_an_enabled_import_list_is_never_written_enabled(self):
        spec = {
            "name": "Watchlist",
            "implementation": "PlexImport",
            "properties": {"enabled": True, "enableAuto": True},
        }
        plan = self.plan("importlist", plex_list(), [], spec)
        (write,) = plan.writes
        self.assertFalse(write["body"]["enabled"] or write["body"]["enableAuto"])
        self.assertIsNone(write["then"])
        self.assertEqual(len(plan.held), 1)

        live = plex_list(1, enabled=True)
        live["enableAuto"] = False
        plan = self.plan("importlist", plex_list(), [live], spec)
        self.assertEqual(plan.writes, [])
        self.assertEqual(len(plan.held), 1)

    def test_a_ui_rename_is_matched_by_id_and_another_implementation_never(self):
        renamed = dict(telegram(1), name="Renamed")
        spec = {"id": 1, "name": "Telegram", "implementation": "Telegram"}
        self.assertIs(arr_sync.find_provider([renamed], spec), renamed)
        other = dict(telegram(1), name="Discord", implementation="Discord")
        self.assertIsNone(arr_sync.find_provider([other], spec))

    def test_host_settings_never_take_a_credential_and_echo_the_live_login(self):
        live = {
            "id": 1,
            "username": "admin",
            "password": "live-hash",
            "bindAddress": "*",
        }
        plan = arr_sync.Plan()
        api = Api({"/config/host": live})
        arr_sync.plan_settings(api, plan, {"config/host": {"password": "new"}})
        self.assertEqual((plan.writes, len(plan.problems)), ([], 1))

        plan = arr_sync.Plan()
        arr_sync.plan_settings(api, plan, {"config/host": {"bindAddress": "127.0.0.1"}})
        (write,) = plan.writes
        self.assertEqual(write["body"]["password"], "live-hash")


class RedactTest(unittest.TestCase):
    def test_no_secret_reaches_the_before_image(self):
        url_secret = "plex-token-inside-a-url"
        reads = {
            "/notification": [
                # unmasked privacy field, and a declared secret field differing from SOPS
                {
                    "fields": [
                        {"name": "botToken", "value": "unmasked", "privacy": "apiKey"}
                    ]
                },
                {"fields": [{"name": "chatId", "value": "live-chat-id"}]},
            ],
            "/importlist": [
                {"fields": [{"name": "url", "value": f"https://p/?t={url_secret}"}]}
            ],
            "/config/host": {
                "apiKey": "api-key",
                "password": "hash",
                "bindAddress": "*",
            },
        }
        out = json.dumps(arr_sync.redacted(reads, {url_secret, "abc"}, {"chatId"}))
        for secret in ("unmasked", "live-chat-id", url_secret, "api-key", "hash"):
            self.assertNotIn(secret, out)
        # a short secret file value is redacted only as a whole value
        self.assertEqual(arr_sync.redacted("abcdef", {"abc"}), "abcdef")


class RestoreLoginTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = os.path.join(directory.name, "radarr.db")
        with sqlite3.connect(self.database) as con:
            con.execute(
                "CREATE TABLE Users (Id INTEGER PRIMARY KEY AUTOINCREMENT, Identifier TEXT NOT NULL,"
                " Username TEXT NOT NULL, Password TEXT NOT NULL, Salt TEXT, Iterations INTEGER)"
            )
        con.close()
        self.login = {
            "identifier": str(uuid.uuid4()),
            "username": "admin",
            "password": base64.b64encode(b"p" * 32).decode(),
            "salt": base64.b64encode(b"s" * 16).decode(),
            "iterations": 10000,
        }
        self.secret = os.path.join(directory.name, "login.json")
        with open(self.secret, "w") as handle:
            json.dump(self.login, handle)

    def rows(self):
        con = sqlite3.connect(self.database)
        try:
            return arr_sync.login_rows(con)
        finally:
            con.close()

    def test_a_login_is_restored_only_into_an_empty_users_table(self):
        arr_sync.restore_login(self.database, self.secret)
        self.assertEqual(self.rows(), [self.login])

        changed = dict(self.login, password=base64.b64encode(b"q" * 32).decode())
        with open(self.secret, "w") as handle:
            json.dump(changed, handle)
        with self.assertRaises(SystemExit):
            arr_sync.restore_login(self.database, self.secret)
        self.assertEqual(self.rows(), [self.login])


if __name__ == "__main__":
    result = unittest.main(argv=[sys.argv[0], "-v"], exit=False).result
    sys.exit(0 if result.wasSuccessful() else 1)
