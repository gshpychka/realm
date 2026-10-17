"""Offline tests for reconcile.py against a fake Tautulli API v2.

The fake mirrors the Tautulli 2.18 notifier functions (plexpy/notifiers.py):
truthy-only friendly_name/custom_conditions/custom_conditions_logic, password
masking and the four-space skip, string-stored config with int casts on read,
NULL templates read back as defaults, AUTOINCREMENT ids. Only synthetic
secrets are used.

usage: test_reconcile.py <schema.json>
"""

import contextlib
import copy
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import reconcile

SCHEMA = json.loads(Path(sys.argv[1]).read_text())
del sys.argv[1:]

API_KEY = "synthetic-api-key-0123456789abcd"
SECRETS = {
    "api": API_KEY,
    "bot": "123456789:SYNTHETIC-bot-token-abcdefghijklmnopq",
    "legacy-chat": "-1001111111111",
    "group-chat": "-1002222222222",
    "smtp": "synthetic-smtp-password",
}

PARAMETER_TYPES = {"library_name": "str", "episode_count": "int", "media_type": "str"}
MASK = "    "


def cast_to_int(value):
    try:
        return int(value)
    except (ValueError, TypeError):
        return 0


class FakeTautulli:
    def __init__(self):
        self.rows = {}
        self.next_id = 1
        self.calls = []
        # stands in for everything else in tautulli.db
        self.history = [{"id": 1, "user": "someone", "rating_key": 42}]
        self.lock = threading.Lock()

    def agent(self, name):
        return SCHEMA["agents"][name]

    def insert(self, row):
        self.rows[self.next_id] = row
        self.next_id += 1
        return self.next_id - 1

    def new_row(self, agent_name):
        row = {
            "agent_id": self.agent(agent_name)["id"],
            "agent_name": agent_name,
            "agent_label": agent_name.title(),
            "friendly_name": "",
            "notifier_config": json.dumps(self.agent(agent_name)["config"]),
            "custom_conditions": json.dumps(SCHEMA["default_custom_conditions"]),
            "custom_conditions_logic": "",
        }
        for action, text in SCHEMA["actions"].items():
            row[action] = 0
            row[f"{action}_subject"] = text["subject"]
            row[f"{action}_body"] = text["body"]
        return row

    # API commands

    def get_notifiers(self):
        return [
            {
                "id": i,
                "agent_id": r["agent_id"],
                "agent_name": r["agent_name"],
                "agent_label": r["agent_label"],
                "friendly_name": r["friendly_name"],
                "active": int(any(r[a] for a in SCHEMA["actions"])),
            }
            for i, r in sorted(self.rows.items())
        ]

    def get_notifier_config(self, notifier_id, mask_passwords=True):
        row = copy.deepcopy(self.rows[int(notifier_id)])
        defaults = self.agent(row["agent_name"])["config"]
        stored = json.loads(row.pop("notifier_config"))
        config = {
            k: cast_to_int(stored.get(k, v)) if isinstance(v, int) else stored.get(k, v)
            for k, v in defaults.items()
        }
        if mask_passwords:
            config = {
                k: MASK if "password" in k and v != "" else v for k, v in config.items()
            }
        actions, texts = {}, {}
        for action, default in SCHEMA["actions"].items():
            subject, body = row.pop(f"{action}_subject"), row.pop(f"{action}_body")
            texts[action] = {
                "subject": default["subject"] if subject is None else subject,
                "body": default["body"] if body is None else body,
            }
            actions[action] = cast_to_int(row.pop(action))
        try:
            row["custom_conditions"] = json.loads(row["custom_conditions"])
        except (ValueError, TypeError):
            row["custom_conditions"] = SCHEMA["default_custom_conditions"]
        row["custom_conditions_logic"] = row["custom_conditions_logic"] or ""
        return {
            "id": int(notifier_id),
            **row,
            "config": config,
            "actions": actions,
            "notify_text": texts,
        }

    def add_notifier_config(self, agent_id):
        name = next(n for n, a in SCHEMA["agents"].items() if a["id"] == int(agent_id))
        new_id = self.insert(self.new_row(name))
        return {"result": "success", "message": "Added", "notifier_id": new_id}

    @staticmethod
    def validate_conditions(raw):
        conditions = json.loads(raw)
        if not isinstance(conditions, list):
            return False
        result = []
        for c in conditions:
            validated = dict(SCHEMA["default_custom_conditions"][0])
            if c.get("parameter"):
                if c["parameter"] not in PARAMETER_TYPES:
                    return False
                validated["parameter"] = c["parameter"]
                validated["type"] = PARAMETER_TYPES[c["parameter"]]
                if c.get("operator"):
                    validated["operator"] = c["operator"]
            if c.get("value"):
                validated["value"] = (
                    c["value"] if isinstance(c["value"], list) else [c["value"]]
                )
            result.append(validated)
        return result

    def set_notifier_config(self, notifier_id, **kwargs):
        notifier_id = int(notifier_id)
        notifier = self.get_notifier_config(notifier_id, mask_passwords=False)
        prefix = notifier["agent_name"] + "_"
        actions = {
            k: cast_to_int(kwargs.pop(k))
            for k in list(kwargs)
            if k in SCHEMA["actions"]
        }
        texts = {
            k: kwargs.pop(k)
            for k in list(kwargs)
            if k.endswith(("_subject", "_body"))
            and k.rsplit("_", 1)[0] in SCHEMA["actions"]
        }
        config = {
            k[len(prefix) :]: kwargs.pop(k)
            for k in list(kwargs)
            if k.startswith(prefix)
        }
        for key in notifier["config"]:
            if key in config:
                if "password" in key and config[key] == MASK:
                    continue
                notifier["config"][key] = config[key]
        if friendly_name := kwargs.get("friendly_name"):
            notifier["friendly_name"] = friendly_name
        if custom_conditions := kwargs.get("custom_conditions"):
            validated = self.validate_conditions(custom_conditions)
            if not validated:
                return {
                    "result": "error",
                    "message": "Failed to save notification agent.",
                }
            notifier["custom_conditions"] = validated
        if logic := kwargs.get("custom_conditions_logic"):
            notifier["custom_conditions_logic"] = logic
        row = self.rows[notifier_id]
        row.update(
            friendly_name=notifier["friendly_name"],
            notifier_config=json.dumps(notifier["config"]),
            custom_conditions=json.dumps(notifier["custom_conditions"]),
            custom_conditions_logic=notifier["custom_conditions_logic"],
        )
        row.update(actions)
        row.update(texts)
        return {"result": "success", "message": "Saved notification agent."}

    def handle(self, method, cmd, key, params):
        with self.lock:
            self.calls.append((method, cmd, sorted(params)))
            if key != API_KEY:
                return {"result": "error", "message": "Invalid apikey", "data": {}}
            if cmd not in reconcile.READ_COMMANDS | reconcile.WRITE_COMMANDS:
                return {
                    "result": "error",
                    "message": f"Unknown command: {cmd}",
                    "data": {},
                }
            return {
                "result": "success",
                "message": None,
                "data": getattr(self, cmd)(**params),
            }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _serve(self, method):
        url = urllib.parse.urlsplit(self.path)
        params = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
        if method == "POST":
            length = int(self.headers["Content-Length"])
            body = self.rfile.read(length).decode()
            params.update(urllib.parse.parse_qsl(body, keep_blank_values=True))
        cmd = params.pop("cmd")
        reply = self.server.fake.handle(
            method, cmd, self.headers.get("X-Api-Key"), params
        )
        data = json.dumps({"response": reply}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._serve("GET")

    def do_POST(self):
        self._serve("POST")


def notifier(notifier_id, **overrides):
    """A synthetic declared Telegram notifier."""
    base = {
        "id": notifier_id,
        "agent": "telegram",
        "friendly_name": f"Telegram - {notifier_id}",
        "config": {
            "disable_web_preview": 0,
            "silent_notification": True,
            "html_support": 1,
            "incl_subject": 0,
            "incl_poster": 1,
        },
        "secret_config": {
            "bot_token": {"credential": "bot"},
            "chat_id": {"credential": "group-chat", "suffix": "/22"},
        },
        "actions": ["on_created"],
        "text": {
            "on_created": {
                "subject": "Plex ({server_name})",
                "body": "{title} доступно",
            }
        },
        "custom_conditions": [
            {"parameter": "library_name", "operator": "is", "value": ["TV Shows"]},
            {
                "parameter": "episode_count",
                "operator": "is greater than",
                "value": ["1"],
            },
        ],
        "custom_conditions_logic": "",
    }
    return {**base, **overrides}


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeTautulli()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.fake = self.fake
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.tmp = Path(tempfile.mkdtemp())
        for name, value in SECRETS.items():
            (self.tmp / name).write_text(value + "\n")
        self.output = io.StringIO()

    def run_reconcile(self, desired, api_key=API_KEY):
        desired = {"api_key_credential": "api", **desired}
        reconcile.check(desired, SCHEMA)
        api = reconcile.Api(
            f"http://127.0.0.1:{self.server.server_port}", api_key, timeout=5
        )
        with contextlib.redirect_stdout(self.output):
            return reconcile.reconcile(api, desired, SCHEMA, self.tmp, deadline=0)

    def writes(self):
        return [c for c in self.fake.calls if c[1] in reconcile.WRITE_COMMANDS]

    def assert_no_secret_output(self):
        text = self.output.getvalue()
        for value in SECRETS.values():
            self.assertNotIn(value, text)

    def seed(self, declared):
        """Live rows exactly matching a declared notifier, stored the way the
        UI stores them (ints in config, NULL for an untouched template)."""
        for n in sorted(declared, key=lambda n: n["id"]):
            while self.fake.next_id < n["id"]:
                self.fake.next_id += 1
            row = self.fake.new_row(n["agent"])
            config = {
                k: int(v) if isinstance(v, bool) else v for k, v in n["config"].items()
            }
            for key, secret in n["secret_config"].items():
                config[key] = SECRETS[secret["credential"]] + secret.get("suffix", "")
            row["notifier_config"] = json.dumps(config)
            row["friendly_name"] = n["friendly_name"]
            for action in n["actions"]:
                row[action] = 1
            for action, text in n["text"].items():
                for part, value in text.items():
                    row[f"{action}_{part}"] = value
            row["on_tokenexpired_subject"] = row["on_tokenexpired_body"] = None
            validated = FakeTautulli.validate_conditions(
                json.dumps(
                    n["custom_conditions"] or SCHEMA["default_custom_conditions"]
                )
            )
            row["custom_conditions"] = json.dumps(validated)
            row["custom_conditions_logic"] = n["custom_conditions_logic"]
            self.fake.insert(row)

    def test_converged_state_makes_zero_changes_twice(self):
        declared = [notifier(1, actions=[], friendly_name=""), notifier(2), notifier(3)]
        self.seed(declared)
        before = copy.deepcopy(self.fake.rows)
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)
        self.assertEqual(self.writes(), [])
        # byte-identical rows, NULL templates included
        self.assertEqual(self.fake.rows, before)
        self.assertIsNone(self.fake.rows[2]["on_tokenexpired_body"])
        self.assert_no_secret_output()

    def test_drift_is_corrected_field_by_field_then_converges(self):
        declared = [notifier(1), notifier(2, actions=["on_error", "on_extdown"])]
        self.seed(declared)
        row = self.fake.rows[2]
        row["on_error"] = 0
        row["on_play"] = 1
        row["on_extdown_body"] = "changed"
        config = json.loads(row["notifier_config"])
        config.update(chat_id=SECRETS["group-chat"] + "/16", silent_notification=0)
        row["notifier_config"] = json.dumps(config)
        row["custom_conditions"] = json.dumps([])
        self.assertGreater(self.run_reconcile({"notifiers": declared}), 0)
        set_calls = [c for c in self.writes() if c[1] == "set_notifier_config"]
        self.assertEqual(len(set_calls), 1)
        self.assertEqual(
            set_calls[0][2],
            sorted(
                [
                    "notifier_id",
                    "on_error",
                    "on_play",
                    "on_extdown_body",
                    "telegram_chat_id",
                    "telegram_silent_notification",
                    "custom_conditions",
                ]
            ),
        )
        # the unchanged token was never sent
        self.assertNotIn("telegram_bot_token", set_calls[0][2])
        live = self.fake.get_notifier_config(2)
        self.assertEqual(live["config"]["chat_id"], SECRETS["group-chat"] + "/22")
        self.assertEqual(
            {a for a, v in live["actions"].items() if v}, {"on_error", "on_extdown"}
        )
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)
        self.assertEqual(sorted(self.fake.rows), [1, 2])
        self.assert_no_secret_output()

    def test_every_action_flag_is_exact(self):
        declared = [notifier(1, actions=["on_play", "on_tokenexpired"])]
        self.seed([notifier(1, actions=list(SCHEMA["actions"]))])
        self.run_reconcile({"notifiers": declared})
        live = self.fake.get_notifier_config(1)["actions"]
        self.assertEqual(set(live), set(SCHEMA["actions"]))
        self.assertEqual(
            {a for a, v in live.items() if v}, {"on_play", "on_tokenexpired"}
        )

    def test_empty_database_gets_stable_ids(self):
        declared = [notifier(i) for i in (1, 2, 3)]
        self.run_reconcile({"notifiers": declared})
        self.assertEqual(sorted(self.fake.rows), [1, 2, 3])
        self.fake.calls.clear()
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)
        self.assertEqual(self.writes(), [])

    def test_absent_id_below_existing_ids_is_refused(self):
        self.seed([notifier(2)])
        with self.assertRaisesRegex(reconcile.ReconcileError, "cannot be recreated"):
            self.run_reconcile({"notifiers": [notifier(1), notifier(2)]})
        self.assertEqual(self.writes(), [])

    def test_unexpected_created_id_is_reported(self):
        self.fake.next_id = 5  # an id was used and deleted before
        with self.assertRaisesRegex(reconcile.ReconcileError, "created notifier 5"):
            self.run_reconcile({"notifiers": [notifier(4)]})

    def test_blank_clears(self):
        declared = [
            notifier(
                1,
                text={"on_created": {"subject": "", "body": "{title}"}},
                custom_conditions=[],
            )
        ]
        self.seed([notifier(1)])
        self.run_reconcile({"notifiers": declared})
        live = self.fake.get_notifier_config(1)
        self.assertEqual(live["notify_text"]["on_created"]["subject"], "")
        self.assertEqual(
            reconcile.normalize_conditions(live["custom_conditions"], SCHEMA),
            reconcile.normalize_conditions([], SCHEMA),
        )
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)

    def test_blank_name_or_logic_cannot_be_set_and_nothing_is_written(self):
        self.seed([notifier(1), notifier(2, custom_conditions_logic="{1} or {2}")])
        self.fake.rows[1]["on_play"] = 1  # drift that would otherwise be fixed
        for declared in (
            [
                notifier(1),
                notifier(2, friendly_name="", custom_conditions_logic="{1} or {2}"),
            ],
            [notifier(1), notifier(2)],
        ):
            with self.assertRaisesRegex(reconcile.ReconcileError, "cannot blank"):
                self.run_reconcile({"notifiers": declared})
        self.assertEqual(self.writes(), [])
        self.assertEqual(self.fake.rows[1]["on_play"], 1)

    def test_logic_is_applied(self):
        self.seed([notifier(1)])
        declared = [notifier(1, custom_conditions_logic="{1} or {2}")]
        self.run_reconcile({"notifiers": declared})
        self.assertEqual(self.fake.rows[1]["custom_conditions_logic"], "{1} or {2}")
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)

    def test_changed_secret_is_sent_and_converges(self):
        self.seed([notifier(1)])
        declared = [
            notifier(
                1,
                secret_config={
                    **notifier(1)["secret_config"],
                    "bot_token": {"credential": "smtp"},
                },
            )
        ]
        self.run_reconcile({"notifiers": declared})
        self.assertEqual(
            self.fake.get_notifier_config(1)["config"]["bot_token"], SECRETS["smtp"]
        )
        self.assertEqual(self.run_reconcile({"notifiers": declared}), 0)
        self.assert_no_secret_output()

    def email(self, password):
        config = dict(SCHEMA["agents"]["email"]["config"])
        config.pop("smtp_password")
        return {
            "id": 1,
            "agent": "email",
            "friendly_name": "Mail",
            "config": config,
            "secret_config": {"smtp_password": {"credential": password}},
            "actions": [],
            "text": {},
            "custom_conditions": [],
            "custom_conditions_logic": "",
        }

    def test_masked_password_is_not_compared_or_sent_back(self):
        (self.tmp / "other").write_text("another-synthetic-password\n")
        self.seed([self.email("smtp")])
        self.assertEqual(
            self.fake.get_notifier_config(1)["config"]["smtp_password"], MASK
        )
        self.assertEqual(self.run_reconcile({"notifiers": [self.email("other")]}), 0)
        self.assertEqual(self.writes(), [])
        stored = json.loads(self.fake.rows[1]["notifier_config"])["smtp_password"]
        self.assertEqual(stored, SECRETS["smtp"])

    def test_masked_password_is_cleared_when_declared_blank(self):
        (self.tmp / "empty").write_text("\n")
        self.seed([self.email("smtp")])
        self.run_reconcile({"notifiers": [self.email("empty")]})
        self.assertEqual(
            json.loads(self.fake.rows[1]["notifier_config"])["smtp_password"], ""
        )
        self.assertEqual(self.run_reconcile({"notifiers": [self.email("empty")]}), 0)

    def test_undeclared_notifier_and_history_are_preserved(self):
        self.seed([notifier(1), notifier(2)])
        extra = copy.deepcopy(self.fake.rows[2])
        history = copy.deepcopy(self.fake.history)
        self.run_reconcile({"notifiers": [notifier(1)]})
        self.assertEqual(self.fake.rows[2], extra)
        self.assertEqual(self.fake.history, history)
        self.assertIn("notifier 2 is not declared", self.output.getvalue())

    def test_wrong_agent_at_id_is_refused(self):
        self.seed([self.email("smtp")])
        with self.assertRaisesRegex(reconcile.ReconcileError, "live agent is email"):
            self.run_reconcile({"notifiers": [notifier(1)]})
        self.assertEqual(self.writes(), [])

    def test_only_allowed_commands_are_used(self):
        self.seed([notifier(1)])
        self.fake.rows[1]["on_play"] = 1
        self.run_reconcile({"notifiers": [notifier(1)]})
        self.run_reconcile({"notifiers": [notifier(2)] + [notifier(1)]})
        used = {c[1] for c in self.fake.calls}
        self.assertLessEqual(used, reconcile.READ_COMMANDS | reconcile.WRITE_COMMANDS)
        for method, cmd, _ in self.fake.calls:
            self.assertEqual(
                method, "POST" if cmd in reconcile.WRITE_COMMANDS else "GET"
            )
        api = reconcile.Api("http://127.0.0.1:1", API_KEY)
        with self.assertRaisesRegex(reconcile.ReconcileError, "refusing"):
            api.call("notify", notifier_id=1)

    def test_wrong_api_key_fails_without_writes(self):
        self.seed([notifier(1)])
        with self.assertRaisesRegex(reconcile.ReconcileError, "Invalid apikey"):
            self.run_reconcile({"notifiers": [notifier(1)]}, api_key="wrong")
        self.assertEqual(self.writes(), [])

    def test_check_rejects_incomplete_or_unknown_declarations(self):
        bad = notifier(1)
        del bad["config"]["incl_poster"]
        for declared in (
            [bad],
            [notifier(1, actions=["on_nothing"])],
            [notifier(1), notifier(1)],
            [notifier(1, agent="nope")],
        ):
            with self.assertRaises(reconcile.ReconcileError):
                reconcile.check({"notifiers": declared}, SCHEMA)

    def test_api_key_mismatch_stops_before_any_call(self):
        state = self.tmp / "state.json"
        state.write_text(json.dumps({"adopted": [], "mismatched": ["api"]}))
        with self.assertRaisesRegex(reconcile.ReconcileError, "not calling the API"):
            reconcile.read_state(state, "api")
        state.write_text(json.dumps({"adopted": ["api"], "mismatched": ["plex"]}))
        self.assertEqual(reconcile.read_state(state, "api"), ["plex"])

    def run_preview(self, desired):
        desired = {"api_key_credential": "api", **desired}
        reconcile.check(desired, SCHEMA)
        api = reconcile.Api(f"http://127.0.0.1:{self.server.server_port}", API_KEY)
        api.call = reconcile.ReadOnly(api.call)
        with contextlib.redirect_stdout(self.output):
            return reconcile.preview(api, desired, SCHEMA, self.tmp, deadline=0)

    def test_preview_flags_a_differing_secret_without_sending_it(self):
        self.seed([notifier(1), notifier(2)])
        config = json.loads(self.fake.rows[2]["notifier_config"])
        config["bot_token"] = "987654321:ANOTHER-synthetic-live-token"
        self.fake.rows[2]["notifier_config"] = json.dumps(config)
        self.fake.rows[1]["on_play"] = 1  # non-secret drift is only reported
        self.assertFalse(self.run_preview({"notifiers": [notifier(1), notifier(2)]}))
        self.assertIn("notifier 2: secret telegram_bot_token", self.output.getvalue())
        self.assertIn("notifier 1: would update on_play", self.output.getvalue())
        self.assertEqual(self.writes(), [])
        self.assertNotIn("ANOTHER-synthetic-live-token", self.output.getvalue())
        self.assert_no_secret_output()

    def test_preview_refuses_a_missing_notifier_and_any_write(self):
        self.seed([notifier(1)])
        self.assertFalse(self.run_preview({"notifiers": [notifier(1), notifier(2)]}))
        self.assertIn("notifier 2: missing", self.output.getvalue())
        self.assertEqual(self.writes(), [])
        api = reconcile.Api(f"http://127.0.0.1:{self.server.server_port}", API_KEY)
        api.call = reconcile.ReadOnly(api.call)
        with self.assertRaisesRegex(reconcile.ReconcileError, "preview refuses"):
            api.call("set_notifier_config", notifier_id=1, on_play="0")
        self.assertEqual(self.writes(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
