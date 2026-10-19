"""Exercise offline credential preparation with synthetic records only.

The official broker validates configuration and exits without a listener.
No inventory, real credentials or running service is used.
"""

import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch


def main():
    spec = importlib.util.spec_from_file_location("prepare_mqtt", sys.argv[1])
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    plugin_directory = Path(sys.argv[2])
    with tempfile.TemporaryDirectory(prefix="ha-mqtt-qa-") as temporary:
        root = Path(temporary)
        (root / ".storage").mkdir()
        (root / ".storage/core.config_entries").write_text(
            json.dumps(
                {
                    "data": {
                        "entries": [
                            {
                                "domain": "mqtt",
                                "data": {
                                    "username": "fixture-ha",
                                    "password": "fixture:password",
                                },
                            }
                        ]
                    }
                }
            )
        )
        clients = root / "clients.json"
        clients.write_text(
            json.dumps(
                [
                    {
                        "username": "fixture-external",
                        "password": "fixture-external-password",
                    }
                ]
            )
        )
        passwords = root / "passwords"
        report = helper.prepare(root, clients, passwords)
        assert report["hashed_users"] == 2
        assert not report["complete_client_inventory_acknowledged"]
        assert not report["readiness_marker_created"]
        assert stat.S_IMODE(passwords.stat().st_mode) == 0o600
        hashes = dict(line.split(":", 1) for line in passwords.read_text().splitlines())
        assert set(hashes) == {"fixture-ha", "fixture-external"}
        assert all(value.startswith("$") for value in hashes.values())
        assert "fixture:password" not in passwords.read_text()
        assert "fixture-external-password" not in passwords.read_text()
        try:
            helper.prepare(root, clients, passwords)
        except ValueError:
            pass
        else:
            raise AssertionError("existing credentials were overwritten")
        clients.write_text(
            json.dumps([{"username": "fixture-ha", "password": "conflicting-fixture"}])
        )
        try:
            helper.prepare(root, clients, root / "conflicting")
        except ValueError:
            pass
        else:
            raise AssertionError("conflicting client identity was accepted")
        raced = root / "raced-passwords"
        original_link = helper.os.link

        def concurrent_creation(source, destination):
            Path(destination).write_text("synthetic concurrent operator file")
            return original_link(source, destination)

        with patch.object(helper.os, "link", concurrent_creation):
            try:
                helper.prepare(root, None, raced)
            except FileExistsError:
                pass
            else:
                raise AssertionError("concurrent destination was overwritten")
        assert raced.read_text() == "synthetic concurrent operator file"
        acl = root / "acl"
        acl.write_text("topic readwrite #\n")
        configuration = root / "mosquitto.conf"
        configuration.write_text(
            "listener 18830 127.0.0.1\nallow_anonymous false\n"
            f"plugin {plugin_directory}/mosquitto_acl_file.so\n"
            f"plugin_opt_acl_file {acl}\n"
            f"plugin {plugin_directory}/mosquitto_password_file.so\n"
            f"plugin_opt_password_file {passwords}\n"
        )
        subprocess.run(
            ["mosquitto", "-c", str(configuration), "--test-config"],
            capture_output=True,
            check=True,
        )
    print(
        json.dumps(
            {
                "mqtt_offline_hashing_and_configuration": "passed",
                "network_listener_started": False,
            }
        )
    )


if __name__ == "__main__":
    main()
