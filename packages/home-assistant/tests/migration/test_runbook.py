"""Exercise real private-file, broker hash, archive and encrypted-restore paths."""

import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(sys.argv.pop(1)).resolve()


class RunbookTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.root.chmod(0o700)

    def tearDown(self):
        self.directory.cleanup()

    def run_phase(self, *args, success=True):
        result = subprocess.run(
            ["bash", str(SCRIPT), *map(str, args)],
            text=True,
            capture_output=True,
            env={**os.environ, "RESTIC_CACHE_DIR": str(self.root / "cache")},
            check=False,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("PRIVATE_SENTINEL", result.stdout + result.stderr)
        return result

    def private(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(0o600)
        return path

    def test_mqtt_real_hashes_and_invalid_inputs(self):
        users = self.private(
            "mqtt.json",
            json.dumps(
                [
                    {"username": "hass", "password": "PRIVATE_SENTINEL"},
                    {"username": "other", "password": "space % пароль"},
                ]
            ),
        )
        output = self.root / "passwords"
        self.run_phase("mqtt-passwords", users, output)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        hashes = output.read_text().splitlines()
        self.assertEqual([line.split(":")[0] for line in hashes], ["hass", "other"])
        self.assertTrue(all("PRIVATE_SENTINEL" not in line for line in hashes))
        self.run_phase("mqtt-passwords", users, output, success=False)
        users.write_text('[{"username":"x","password":"a\\nb"}]')
        self.run_phase("mqtt-passwords", users, self.root / "invalid", success=False)
        users.write_text(
            '[{"username":"x","password":"a"},{"username":"x","password":"b"}]'
        )
        self.run_phase("mqtt-passwords", users, self.root / "duplicate", success=False)
        users.chmod(0o644)
        self.run_phase("mqtt-passwords", users, self.root / "public", success=False)

    def credential_input(self):
        settings = {
            "soundbar_api_key": "PRIVATE_SENTINEL",
            "yasno_address_guard": {
                "entry_id": "fixture",
                "region_id": 1,
                "provider_id": 2,
                "street_id": 3,
                "house_id": 4,
                "bindings": {"fixture": "sensor.fixture"},
                "journal_path": "/var/lib/hass/yasno-address-guard/journal.json",
                "app_path": "/var/lib/hass/pyscript/apps/yasno_address_guard",
                "settings": {
                    "region": "x",
                    "provider": "y",
                    "scan_interval": 15,
                    "filter_probable": True,
                    "status_all_day_events": True,
                },
            },
        }
        self.private("input/secrets.yaml", json.dumps(settings))
        self.private(
            "input/ha-mcp.env",
            "HOMEASSISTANT_TOKEN=PRIVATE_SENTINEL\nMCP_SECRET_PATH=/" + "a" * 32 + "\n",
        )
        self.private("input/mosquitto-passwords", "fixture:$7$hash\n")
        self.private("input/restic-repository", str(self.root / "repo") + "\n")
        self.private("input/restic-password", "PRIVATE_SENTINEL\n")
        self.private("input/restic-environment", "")
        return self.root / "input"

    def test_credentials_literal_environment_and_complete_schema(self):
        source = self.credential_input()
        output = self.root / "output"
        self.run_phase("credentials", source, output)
        self.assertEqual(len(list(output.iterdir())), 6)
        self.private("input/restic-environment", "PATH=/tmp\n")
        self.run_phase("credentials", source, self.root / "bad", success=False)
        marker = self.root / "must-not-exist"
        self.private(
            "input/restic-environment", f"AWS_ACCESS_KEY_ID=$(touch {marker})\n"
        )
        self.run_phase("credentials", source, self.root / "literal", success=False)
        self.assertFalse(marker.exists())
        self.private("input/secrets.yaml", '{"soundbar_api_key":"PRIVATE_SENTINEL"}')
        self.run_phase("credentials", source, self.root / "missing", success=False)

    def capture(self):
        capture = self.root / "capture"
        capture.mkdir(mode=0o700)
        config = self.root / "config"
        (config / ".storage").mkdir(parents=True)
        (config / ".storage/auth").write_text('{"fixture":"PRIVATE_SENTINEL"}')
        with tarfile.open(capture / "config.tar", "w") as archive:
            archive.add(config, arcname=".")
        self.private("capture/inventory.json", '{"schema_version":1}')
        self.private("capture/CAPTURE_COMPLETE", "haos-cold-capture-v1\n")
        self.write_manifest(capture)
        return capture

    def write_manifest(self, capture):
        self.private(
            "capture/SHA256SUMS",
            "".join(
                hashlib.sha256(path.read_bytes()).hexdigest()
                + "  ./"
                + path.name
                + "\n"
                for path in sorted(capture.iterdir())
                if path.name != "SHA256SUMS"
            ),
        )

    def test_capture_integrity_and_safe_unpack(self):
        capture = self.capture()
        self.run_phase("unpack", capture, capture / "recursive", success=False)
        self.run_phase("unpack", capture, self.root / "extracted")
        self.assertTrue((self.root / "extracted/homeassistant/.storage/auth").is_file())
        with (capture / "config.tar").open("ab") as stream:
            stream.write(b"changed")
        self.run_phase("unpack", capture, self.root / "tampered", success=False)

    def test_real_encrypted_capture_restore(self):
        capture = self.capture()
        credentials = self.credential_input()
        outbound = self.private("outbound", "PRIVATE_SENTINEL")
        self.run_phase("restic-init", credentials, "--execute")
        self.run_phase("seal", capture, credentials, capture / "proof", success=False)
        self.run_phase("seal", capture, credentials, self.root / "proof", outbound)
        restored = self.root / "proof/restored" / str(outbound).lstrip("/")
        self.assertEqual(restored.read_text(), "PRIVATE_SENTINEL")
        self.assertEqual((self.root / "proof/differences").read_text(), "")
        self.assertRegex(
            (self.root / "proof/snapshot-id").read_text(), r"^[a-f0-9]{64}\n$"
        )

    def test_refuse_remote_api_and_unknown_phase(self):
        token = self.private("token", "PRIVATE_SENTINEL")
        self.run_phase(
            "api-snapshot",
            "https://example.invalid",
            token,
            self.root / "api",
            success=False,
        )
        self.run_phase("no-such-phase", success=False)


if __name__ == "__main__":
    unittest.main()
