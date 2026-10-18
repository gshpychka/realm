import http.server
import importlib.util
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "hermes_runtime", Path(__file__).resolve().parents[1] / "runtime.py"
)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class TemporaryCredentialCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "api.env"


class CredentialTests(TemporaryCredentialCase):
    def test_generate_private_key_and_preserve_it_on_restart(self):
        runtime.prepare(self.path)
        original = runtime.api_key(self.path)
        self.assertGreaterEqual(len(original), 43)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        runtime.prepare(self.path)
        self.assertEqual(runtime.api_key(self.path), original)

    def test_refuse_public_or_malformed_existing_file_without_replacing(self):
        self.path.write_text("do-not-replace\n")
        for mode in (0o644, 0o600):
            self.path.chmod(mode)
            with self.assertRaises(ValueError):
                runtime.prepare(self.path)
            self.assertEqual(self.path.read_text(), "do-not-replace\n")

    def test_refuse_symlink_including_dangling_link(self):
        target = self.path.with_name("target")
        self.path.symlink_to(target)
        with self.assertRaises(OSError):
            runtime.prepare(self.path)
        self.assertFalse(target.exists())
        target.write_text("unchanged")
        with self.assertRaises(OSError):
            runtime.prepare(self.path)
        self.assertEqual(target.read_text(), "unchanged")

    def test_independent_instances_get_different_keys(self):
        other = self.path.with_name("other.env")
        runtime.prepare(self.path)
        runtime.prepare(other)
        self.assertNotEqual(runtime.api_key(self.path), runtime.api_key(other))


class ReadinessTests(TemporaryCredentialCase):
    def serve(self, status=200, body=None):
        runtime.prepare(self.path)
        key = runtime.api_key(self.path)
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                self.send_response(status)
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        body or {"status": "ok", "platform": "hermes-agent"}
                    ).encode()
                )

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_port, key, requests

    def test_checks_authenticated_detailed_health(self):
        port, key, requests = self.serve()
        # Even a process with an unusable HTTP proxy must reach only loopback.
        previous = os.environ.get("http_proxy")
        os.environ["http_proxy"] = "http://127.0.0.1:1"
        try:
            runtime.ready(self.path, port, timeout=1)
        finally:
            if previous is None:
                os.environ.pop("http_proxy", None)
            else:
                os.environ["http_proxy"] = previous
        self.assertEqual(requests, [("/health/detailed", f"Bearer {key}")])

    def test_rejected_credential_fails_immediately(self):
        port, _, requests = self.serve(status=401)
        with self.assertRaisesRegex(RuntimeError, "rejected"):
            runtime.ready(self.path, port, timeout=30)
        self.assertEqual(len(requests), 1)

    def test_http_200_with_degraded_readiness_does_not_pass(self):
        port, _, _ = self.serve(body={"status": "degraded"})
        with self.assertRaisesRegex(RuntimeError, "did not become ready"):
            runtime.ready(self.path, port, timeout=0)

    def test_unrelated_service_does_not_pass(self):
        port, _, _ = self.serve(body={"status": "ok", "platform": "another-service"})
        with self.assertRaisesRegex(RuntimeError, "did not become ready"):
            runtime.ready(self.path, port, timeout=0)


class EnvironmentTests(TemporaryCredentialCase):
    def setUp(self):
        super().setUp()
        runtime.prepare(self.path)
        self.destination = self.path.with_name(".env")
        self.base = self.path.with_name("base.json")
        self.base.write_text(json.dumps({"API_SERVER_HOST": "127.0.0.1"}))
        self.secret = self.path.with_name("sops.env")
        self.secret.write_text("OPENAI_API_KEY=first-key\n")

    def sync(self, *sources):
        runtime.sync_environment(self.destination, self.base, list(sources), self.path)

    def test_rotation_replaces_stale_dotenv_on_restart(self):
        self.sync(str(self.secret))
        self.assertIn("OPENAI_API_KEY=first-key", self.destination.read_text())
        self.secret.write_text("OPENAI_API_KEY=rotated-key\n")
        self.sync(str(self.secret))
        result = self.destination.read_text()
        self.assertIn("OPENAI_API_KEY=rotated-key", result)
        self.assertNotIn("first-key", result)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o600)

    def test_missing_required_source_preserves_previous_file(self):
        self.destination.write_text("previous\n")
        with self.assertRaises(FileNotFoundError):
            self.sync(str(self.secret.with_name("missing")))
        self.assertEqual(self.destination.read_text(), "previous\n")

    def test_optional_bot_and_local_api_key_are_both_in_dotenv(self):
        bot = self.path.with_name("telegram.env")
        self.sync(str(self.secret), f"-{bot}")
        self.assertNotIn("TELEGRAM_BOT_TOKEN", self.destination.read_text())
        bot.write_text("TELEGRAM_BOT_TOKEN=new-bot\nAPI_SERVER_KEY=wrong-key\n")
        self.sync(str(self.secret), f"-{bot}")
        result = self.destination.read_text()
        self.assertIn("TELEGRAM_BOT_TOKEN=new-bot", result)
        self.assertTrue(
            result.endswith(f"API_SERVER_KEY={runtime.api_key(self.path)}\n\n")
        )

    def test_rebuild_does_not_append_duplicate_sources(self):
        self.sync(str(self.secret))
        original = self.destination.read_text()
        self.sync(str(self.secret))
        self.assertEqual(self.destination.read_text(), original)


if __name__ == "__main__":
    unittest.main()
