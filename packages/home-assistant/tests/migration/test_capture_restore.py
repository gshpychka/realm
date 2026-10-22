"""Run the real capture/restore shell programs against isolated fake host tools.

The SSH fixture remaps only HAOS absolute paths; Docker/systemd/disk discovery
record changes in temporary files. No host service, block device or network is used.
"""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

MIGRATION = (
    Path(sys.argv.pop(1)).resolve()
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-")
    else Path(__file__).resolve().parents[2] / "migration"
)
PYTHON = sys.executable
BASH = shutil.which("bash")

FAKE = r"""
import json, os, pathlib, shlex, subprocess, sys
root = pathlib.Path(os.environ["FAKE_HAOS_ROOT"])
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
def record(*parts):
    with (root / "operations").open("a") as stream:
        stream.write(" ".join(parts) + "\n")
if tool == "ssh":
    assert "StrictHostKeyChecking=yes" in args
    assert args[args.index("-p")+1] == "22222"
    code = sys.stdin.read()
    for path in ("/etc/os-release", "/var/lib/bluetooth", "/mnt/data", "/mnt/boot"):
        code = code.replace(path, str(root / path.lstrip("/")))
    command = shlex.split(args[-1])
    command = [str(root / arg.lstrip("/")) if arg.startswith("/mnt/data/.ha-migration-capture.") else arg for arg in command]
    environment = dict(os.environ, SSH_CONNECTION="192.168.1.4 44444 192.168.1.212 22222")
    raise SystemExit(subprocess.run(command, input=code, text=True, env=environment).returncode)
if tool == "id":
    print("0")
elif tool == "docker":
    running = json.loads((root / "running.json").read_text())
    if args[0] == "ps":
        print("\n".join(name for name, active in running.items() if active))
    elif args[0] == "inspect":
        if "--format" not in args:
            print(json.dumps([{"Name": name, "Config": {"Env": ["FIXTURE=private"]}} for name in args[1:]]))
        else:
            format = args[args.index("--format")+1]
            name = args[-1]
            if "Mounts" in format:
                if name == "core" and any("/"+kind in format for kind in ("media", "share", "ssl")):
                    print(root / "core-mounts" / next(kind for kind in ("media", "share", "ssl") if "/"+kind in format))
                else:
                    print(root / "mnt/data/supervisor" if name == "hassio_supervisor" else root / "roles" / name)
            elif "Config.Image" in format:
                print(name + " fixture-image running=" + str(running[name]).lower())
            elif "State.Running" in format:
                print(str(running[name]).lower())
            else:
                if name not in running and name != "hassio_supervisor":
                    raise SystemExit(1)
                print("/" + name)
    elif args[0] in ("start", "stop"):
        name = args[-1]
        record("docker", args[0], name)
        if args[0] == "start" and os.environ.get("FAIL_START") == name:
            raise SystemExit(1)
        running[name] = args[0] == "start"
        (root / "running.json").write_text(json.dumps(running))
        if args[0] == "stop" and os.environ.get("FAIL_STOP") == name:
            raise SystemExit(1)
elif tool == "systemctl":
    record("systemctl", *args)
    if args[0] == "show":
        if args[-1] == "haos-supervisor.service": print("/fixture/haos-supervisor.service")
    elif args[0] == "is-active":
        raise SystemExit(0)
elif tool == "lsblk":
    if "--json" in args:
        disks=[{"path": "/dev/old", "type": "disk", "serial": "OLD-SERIAL", "wwn": "OLD-WWN", "model": "fixture", "size": 500000000000, "maj:min": "1:0", "mountpoints": []}]
        if os.environ.get("SPLIT_BOOT"):
            disks.append(dict(disks[0], path="/dev/boot", serial="BOOT-SERIAL", wwn="BOOT-WWN"))
        print(json.dumps({"blockdevices": disks}))
    elif "PATH,TYPE" in args:
        print("/dev/boot disk" if args[-1] == "/dev/bootp1" else "/dev/old disk")
    elif "SERIAL" in args:
        print("NEW-SERIAL")
    elif "WWN" in args:
        print("NEW-WWN")
    elif "TYPE" in args:
        print("disk")
    elif "PATH" in args:
        print(root / "candidate-disk")
elif tool == "findmnt":
    if "--mountpoint" in args:
        if "TARGET" in args: print(args[-1])
        else: print("/dev/candidatep2")
    elif "--target" in args:
        print("/dev/bootp1" if os.environ.get("SPLIT_BOOT") and args[-1].endswith("/mnt/boot") else "/dev/oldp8")
    else:
        print("fixture mounts")
elif tool == "df":
    print("Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 999999999 1 999999998 0% fixture")
elif tool == "chown":
    record("chown", *args)
elif tool == "stat":
    if args[:2] == ["-c", "%u:%a"]:
        print("0:" + oct(pathlib.Path(args[-1]).stat().st_mode & 0o777)[2:])
    else:
        raise SystemExit(subprocess.run([os.environ["REAL_STAT"], *args]).returncode)
elif tool == "python3":
    code = sys.stdin.read()
    if os.environ.get("LOW_CANDIDATE_SPACE") and "os.statvfs(" in code:
        code = 'import os\nos.statvfs = lambda _path: type("FixtureSpace", (), {"f_bavail": 0, "f_frsize": 4096})()\n' + code
    raise SystemExit(subprocess.run([sys.executable, *args], input=code, text=True).returncode)
elif tool == "install":
    clean=[]
    while args:
        arg=args.pop(0)
        if arg in ("-o", "-g"): args.pop(0)
        else: clean.append(arg)
    if os.environ.get("FAIL_INSTALL_END") and clean[-1].endswith(os.environ["FAIL_INSTALL_END"]):
        raise SystemExit(1)
    raise SystemExit(subprocess.run([os.environ["REAL_INSTALL"], *clean]).returncode)
else:
    raise SystemExit("unknown fake tool")
"""


class CaptureRestore(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in (
            "ssh",
            "id",
            "docker",
            "systemctl",
            "lsblk",
            "findmnt",
            "df",
            "chown",
            "stat",
            "python3",
            "install",
        ):
            path = self.bin / name
            path.write_text(f"#!{PYTHON}\n" + FAKE)
            path.chmod(0o755)
        self.env = dict(
            os.environ,
            FAKE_HAOS_ROOT=str(self.root),
            REAL_INSTALL=shutil.which("install"),
            REAL_STAT=shutil.which("stat"),
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
        )
        self.roles = ("core", "matter", "mqtt", "tailscale", "sshaddon", "mcp")
        for name in self.roles:
            (self.root / "roles" / name).mkdir(parents=True)
        for name in ("media", "share", "ssl"):
            path = self.root / "core-mounts" / name
            path.mkdir(parents=True)
            (path / "fixture").write_text(f"synthetic {name} state")
        (self.root / "etc").mkdir()
        (self.root / "etc/os-release").write_text('ID=haos\nVERSION_ID="18.3"\n')
        (self.root / "mnt/data/supervisor/backup").mkdir(parents=True)
        (self.root / "mnt/boot").mkdir()
        (self.root / "var/lib/bluetooth").mkdir(parents=True)
        with tarfile.open(self.root / "mnt/data/supervisor/backup/original.tar", "w"):
            pass
        core = self.root / "roles/core"
        (core / ".HA_VERSION").write_text("2026.10.2\n")
        (core / ".storage").mkdir()
        (core / "secrets.yaml").write_text("synthetic_private: fixture\n")
        for name in ("home-assistant_v2.db", "zigbee.db"):
            with sqlite3.connect(core / name) as connection:
                connection.execute("CREATE TABLE fixture (id INTEGER)")
            connection.close()
        (self.root / "roles/mqtt/mosquitto.db").write_text("synthetic broker state")
        (self.root / "roles/matter/chip.json").write_text(
            '{"sdk-config":{"fabric":"synthetic"}}'
        )
        (self.root / "roles/matter/123.json").write_text('{"nodes":{}}')
        (self.root / "roles/tailscale/tailscaled.state").write_text(
            "synthetic tail state"
        )
        subprocess.run(
            [
                "ssh-keygen",
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-f",
                str(self.root / "roles/sshaddon/ssh_host_ed25519_key"),
            ],
            check=True,
        )
        (self.root / "running.json").write_text(
            json.dumps(dict.fromkeys((*self.roles, "other_addon"), True))
        )
        self.known = self.root / "known_hosts"
        self.known.write_text("fixture trust file\n")
        self.output = self.root / "capture"

    def capture(self, *extra, success=True):
        args = [
            BASH,
            str(MIGRATION / "capture-haos.sh"),
            "--host",
            "fixture-host",
            "--known-hosts",
            str(self.known),
            "--output",
            str(self.output),
            "--core",
            "core",
            "--matter",
            "matter",
            "--mqtt",
            "mqtt",
            "--tailscale",
            "tailscale",
            "--ssh-addon",
            "sshaddon",
            "--mcp",
            "mcp",
            *extra,
        ]
        result = subprocess.run(args, env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def test_inspection_never_stops_services(self):
        self.capture()
        operations = (self.root / "operations").read_text()
        self.assertNotIn(" stop ", operations)
        self.assertNotIn(" start ", operations)
        self.assertFalse(self.output.exists())

    def test_capture_restores_all_containers_and_checksums_metadata(self):
        self.env["SPLIT_BOOT"] = "1"
        self.capture("--apply", "CAPTURE-HAOS-fixture-host")
        self.assertTrue(
            all(json.loads((self.root / "running.json").read_text()).values())
        )
        self.assertIn(
            "docker start other_addon", (self.root / "operations").read_text()
        )
        containers = json.loads((self.output / "docker-inspect.json").read_text())
        self.assertIn("other_addon", {entry["Name"] for entry in containers})
        inventory = json.loads((self.output / "inventory.json").read_text())
        self.assertEqual(inventory["disk"]["serial"], "OLD-SERIAL")
        self.assertEqual(
            {disk["serial"] for disk in inventory["protected_disks"]},
            {"OLD-SERIAL", "BOOT-SERIAL"},
        )
        self.assertEqual(len((self.output / "SHA256SUMS").read_text().splitlines()), 27)
        subprocess.run(
            ["sha256sum", "--check", "--status", "SHA256SUMS"],
            cwd=self.output,
            check=True,
        )
        self.assertEqual((self.output / "inventory.json").stat().st_mode & 0o777, 0o600)

    def test_failed_stop_restores_even_partially_stopped_container(self):
        self.env["FAIL_STOP"] = "core"
        self.capture("--apply", "CAPTURE-HAOS-fixture-host", success=False)
        self.assertTrue(
            all(json.loads((self.root / "running.json").read_text()).values())
        )
        self.assertFalse((self.output / "CAPTURE_COMPLETE").exists())

    def test_explicit_cutover_leaves_source_stopped(self):
        self.capture("--apply", "CAPTURE-HAOS-fixture-host", "--leave-stopped")
        self.assertFalse(
            any(json.loads((self.root / "running.json").read_text()).values())
        )
        self.assertTrue(
            json.loads((self.output / "inventory.json").read_text())["source"][
                "leave_stopped"
            ]
        )

    def test_addon_port_is_rejected_before_connecting(self):
        self.capture("--port", "22", success=False)
        self.assertFalse((self.root / "operations").exists())

    def recover(self, *extra, journal=None, success=True):
        source = (
            ["--remote-journal", journal]
            if journal
            else ["--capture", str(self.output)]
        )
        result = subprocess.run(
            [
                BASH,
                str(MIGRATION / "recover-haos.sh"),
                *source,
                "--host",
                "fixture-host",
                "--known-hosts",
                str(self.known),
                *extra,
            ],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def rehash_capture(self):
        names = [
            line.split()[1]
            for line in (self.output / "SHA256SUMS").read_text().splitlines()
        ]
        result = subprocess.run(
            ["sha256sum", "--", *names],
            cwd=self.output,
            capture_output=True,
            check=True,
        )
        (self.output / "SHA256SUMS").write_bytes(result.stdout)

    def test_recovery_dry_plan_and_exact_recorded_restart_order(self):
        self.capture("--apply", "CAPTURE-HAOS-fixture-host", "--leave-stopped")
        operations = self.root / "operations"
        operations.write_text("")
        self.recover()
        self.assertNotIn(" start ", operations.read_text())
        self.assertFalse(
            any(json.loads((self.root / "running.json").read_text()).values())
        )
        self.recover("--apply", "RECOVER-HAOS-fixture-host")
        started = [
            line for line in operations.read_text().splitlines() if " start " in line
        ]
        recorded = (self.output / "running-containers").read_text().splitlines()
        self.assertEqual(
            started,
            [
                "systemctl start bluetooth.service",
                *["docker start " + name for name in reversed(recorded)],
                "systemctl start haos-supervisor.service",
            ],
        )
        self.assertTrue(
            all(json.loads((self.root / "running.json").read_text()).values())
        )

    def test_recovery_rejects_tampering_unsafe_metadata_and_wrong_host(self):
        self.capture("--apply", "CAPTURE-HAOS-fixture-host", "--leave-stopped")
        operations = self.root / "operations"
        operations.write_text("")
        self.recover("--apply", "RECOVER-HAOS-other-host", success=False)
        container_file = self.output / "running-containers"
        original = container_file.read_text()
        container_file.write_text(original + "extra\n")
        self.recover("--apply", "RECOVER-HAOS-fixture-host", success=False)
        self.assertEqual(operations.read_text(), "")
        for invalid in ("core\ncore\n", "core;touch-PWNED\n", "hassio_supervisor\n"):
            container_file.write_text(invalid)
            self.rehash_capture()
            self.recover("--apply", "RECOVER-HAOS-fixture-host", success=False)
            self.assertEqual(operations.read_text(), "")
        container_file.write_text(original)
        self.rehash_capture()
        manifest = self.output / "SHA256SUMS"
        original_manifest = manifest.read_text()
        manifest.write_text("invalid-digest" + original_manifest[64:])
        self.recover("--apply", "RECOVER-HAOS-fixture-host", success=False)
        self.assertEqual(operations.read_text(), "")
        manifest.write_text(original_manifest)
        container_file.write_text("missing_container\n")
        self.rehash_capture()
        self.recover("--apply", "RECOVER-HAOS-fixture-host", success=False)
        self.assertNotIn(" start ", operations.read_text())
        container_file.write_text(original)
        self.rehash_capture()
        (self.root / "etc/os-release").write_text("ID=nixos\n")
        self.recover("--apply", "RECOVER-HAOS-fixture-host", success=False)
        self.assertNotIn(" start ", operations.read_text())

    def test_retained_journal_recovery_and_partial_restart_failure(self):
        journal = self.root / "mnt/data/.ha-migration-capture.Abc123"
        journal.mkdir(mode=0o700)
        (journal / "running-containers").write_text("core\nmatter\nother_addon\n")
        (journal / "supervisor-unit").write_text("haos-supervisor.service\n")
        (journal / "active-services").write_text("supervisor=true\nbluetooth=false\n")
        running = dict.fromkeys((*self.roles, "other_addon"), False)
        (self.root / "running.json").write_text(json.dumps(running))
        remote = "/mnt/data/.ha-migration-capture.Abc123"
        self.recover(journal=remote)
        operations = self.root / "operations"
        self.assertNotIn(" start ", operations.read_text())
        self.recover(
            journal="/mnt/data/.ha-migration-capture.Abc123/../other", success=False
        )
        self.env["FAIL_START"] = "matter"
        self.recover(
            "--apply", "RECOVER-HAOS-fixture-host", journal=remote, success=False
        )
        started = [
            line for line in operations.read_text().splitlines() if " start " in line
        ]
        self.assertEqual(
            started,
            [
                "docker start other_addon",
                "docker start matter",
                "docker start core",
                "systemctl start haos-supervisor.service",
            ],
        )
        self.assertTrue(journal.exists())
        del self.env["FAIL_START"]
        self.recover("--apply", "RECOVER-HAOS-fixture-host", journal=remote)
        (journal / "active-services").write_text("supervisor=evil\nbluetooth=true\n")
        operations.write_text("")
        self.recover(
            "--apply", "RECOVER-HAOS-fixture-host", journal=remote, success=False
        )
        self.assertNotIn(" start ", operations.read_text())

    def test_duplicate_role_is_rejected_before_connecting(self):
        self.capture("--mcp", "core", success=False)
        self.assertFalse((self.root / "operations").exists())

    def test_private_capture_cannot_be_written_into_a_git_worktree(self):
        checkout = self.root / "checkout"
        checkout.mkdir()
        (checkout / ".git").write_text("gitdir: synthetic\n")
        self.output = checkout / "private-capture"
        self.capture("--apply", "CAPTURE-HAOS-fixture-host", success=False)
        self.assertFalse((self.root / "operations").exists())
        self.assertFalse(self.output.exists())

    def test_matter_requires_complete_legacy_or_native_controller_state(self):
        code = (
            (MIGRATION / "restore-target.sh")
            .read_text()
            .split("python3 - \"$stage/matter\" <<'PY'\n", 1)[1]
            .split("\nPY\n", 1)[0]
        )
        cases = [
            (
                {
                    "chip.json": {"sdk-config": {"fabric": "synthetic"}},
                    "123.json": {"nodes": {}},
                },
                True,
            ),
            ({"chip.json": {"sdk-config": {"fabric": "synthetic"}}}, False),
            ({"chip.json": {}, "123.json": {"nodes": {}}}, False),
            (
                {
                    "server-2-134b/credentials.fabric": {"fabricId": 2},
                    "server-2-134b/fabrics.fabrics": [{"fabricId": 2}],
                },
                True,
            ),
            ({"server/credentials.fabric": {}, "server/fabrics.fabrics": []}, False),
            ({"server/credentials.fabric": {"fabricId": 1}}, False),
            ({"certificates/cache.json": {"cached": True}}, False),
        ]
        for files, valid in cases:
            with (
                self.subTest(files=list(files)),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                for name, data in files.items():
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(data))
                result = subprocess.run(
                    [PYTHON, "-", str(root)], input=code, text=True, capture_output=True
                )
                self.assertEqual(result.returncode == 0, valid, result.stderr)
                self.assertNotIn("synthetic", result.stderr)

    def test_native_restore_imports_state_and_persistent_masks(self):
        self.capture("--apply", "CAPTURE-HAOS-fixture-host")
        target = self.root / "target"
        (target / "etc/ssh").mkdir(parents=True)
        (target / "etc/systemd").mkdir()
        (target / "var/lib/hass").mkdir(parents=True)
        (target / "etc/passwd").write_text(
            "hass:x:234:234::/:/bin/false\nmosquitto:x:235:235::/:/bin/false\n"
        )
        private = self.root / "private"
        private.mkdir(mode=0o700)
        for name in (
            "secrets.yaml",
            "ha-mcp.env",
            "mosquitto-passwords",
            "restic-repository",
            "restic-password",
            "restic-environment",
        ):
            path = private / name
            path.write_text(
                "" if name == "restic-environment" else "synthetic private fixture\n"
            )
            path.chmod(0o600)
        disk = self.root / "candidate-disk"
        disk.touch()
        # Substitute only the block-device predicate for this file-backed fixture.
        program = self.root / "restore-target.sh"
        program.write_text(
            (MIGRATION / "restore-target.sh")
            .read_text()
            .replace("-b $target_disk", "-f $target_disk")
        )
        args = [
            BASH,
            str(program),
            "--capture",
            str(self.output),
            "--private",
            str(private),
            "--target-root",
            str(target),
            "--target-disk",
            str(disk),
            "--expected-serial",
            "NEW-SERIAL",
        ]
        self.env["LOW_CANDIDATE_SPACE"] = "1"
        low_space = subprocess.run(
            [*args, "--apply", "RESTORE-HOME-ASSISTANT"],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(low_space.returncode, 0)
        self.assertIn("insufficient candidate free space", low_space.stderr)
        self.assertFalse((target / "etc/systemd/system.control").exists())
        self.assertFalse(list((target / "var/lib").glob(".ha-migration-restore.*")))
        self.assertFalse(list((target / "var/lib/hass").iterdir()))
        del self.env["LOW_CANDIDATE_SPACE"]
        checked = subprocess.run(args, env=self.env, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertFalse((target / "etc/systemd/system.control").exists())
        # Simulate keys generated during nixos-install activation. Explicit
        # replacement must preserve them and roll them back after a later error.
        generated_key = target / "etc/ssh/ssh_host_ed25519_key"
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(generated_key)],
            check=True,
        )
        original_identity = generated_key.read_bytes()
        args.append("--replace-generated-host-keys")
        self.env["FAIL_INSTALL_END"] = "/etc/ssh/ssh_host_ed25519_key.pub"
        failed = subprocess.run(
            [*args, "--apply", "RESTORE-HOME-ASSISTANT"],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(generated_key.read_bytes(), original_identity)
        self.assertFalse((target / "var/lib/hass/home-assistant_v2.db").exists())
        self.assertEqual(
            len(list((target / "etc/systemd/system.control").glob("*.service"))), 8
        )
        del self.env["FAIL_INSTALL_END"]
        applied = subprocess.run(
            [*args, "--apply", "RESTORE-HOME-ASSISTANT"],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(applied.returncode, 0, applied.stderr)
        preserved = (
            target
            / "var/lib/private/home-assistant/migration-generated-host-keys/ssh_host_ed25519_key"
        )
        self.assertEqual(preserved.read_bytes(), original_identity)
        self.assertTrue((target / "var/lib/hass/home-assistant_v2.db").is_file())
        self.assertEqual(
            (target / "var/lib/hass/media/fixture").read_text(), "synthetic media state"
        )
        self.assertEqual(
            (target / "var/lib/hass/haos-ssl/fixture").read_text(),
            "synthetic ssl state",
        )
        self.assertEqual(
            (target / "var/lib/hass/haos-share/fixture").read_text(),
            "synthetic share state",
        )
        self.assertEqual(
            (target / "var/lib/tailscale/tailscaled.state").read_text(),
            "synthetic tail state",
        )
        masks = (
            (target / "var/lib/private/home-assistant/migration-masks")
            .read_text()
            .splitlines()
        )
        self.assertEqual(len(masks), 9)
        for mask in masks:
            self.assertEqual((target / mask.lstrip("/")).readlink(), Path("/dev/null"))
        self.assertEqual(
            (target / "var/lib/private/home-assistant/migration-restored").read_text(),
            "haos-state-restored-v1\n",
        )
        again = subprocess.run(
            [*args, "--apply", "RESTORE-HOME-ASSISTANT"],
            env=self.env,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(again.returncode, 0)


if __name__ == "__main__":
    unittest.main()
