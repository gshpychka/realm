"""Exercise candidate-install safety with fake block inventory and commands."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = (
    Path(sys.argv.pop(1))
    if len(sys.argv) > 1
    else Path(__file__).parents[2] / "migration/install-target.sh"
)
MUTATIONS = {
    "wipefs",
    "parted",
    "partprobe",
    "udevadm",
    "mkfs.vfat",
    "mkfs.ext4",
    "mkdir",
    "mount",
    "umount",
    "nixos-install",
    "sync",
}
MOCK = r"""
import json
import os
import sys
from pathlib import Path

command = Path(sys.argv[0]).name
args = sys.argv[1:]
if command == "readlink":
    print(args[-1])
elif command == "lsblk":
    if "--json" in args:
        disks = json.loads(Path(os.environ["INSTALL_DISKS"]).read_text())
        print(json.dumps({"blockdevices": [disks[args[-1]]]}))
    elif "MOUNTPOINTS" in args:
        if os.environ.get("INSTALL_PROBE_FAIL"):
            sys.exit(31)
        print(os.environ.get("INSTALL_MOUNTS", ""))
    elif "PKNAME" in args:
        print(os.environ.get("INSTALL_PARENT", "nvme9n1"))
    elif "TYPE" in args:
        print(os.environ.get("INSTALL_TYPES", "disk\npart\npart").replace("\\n", "\n"))
    else:
        raise AssertionError(args)
elif command == "stat":
    print(os.environ.get("INSTALL_OWNER", "0") if args[1] == "%u" else os.environ.get("INSTALL_MODE", "600"))
elif command == "id":
    print("0")
elif command == "uname":
    print(os.environ.get("INSTALL_ARCH", "aarch64"))
elif command == "nix-store":
    sys.exit(int(os.environ.get("INSTALL_STORE_STATUS", "0")))
else:
    with Path(os.environ["INSTALL_TRACE"]).open("a") as trace:
        trace.write(json.dumps([command, *args]) + "\n")
    if command == "nixos-install":
        sys.exit(47)  # Never create a real mountpoint or install a host system.
"""


class InstallTargetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for command in MUTATIONS | {
            "readlink",
            "lsblk",
            "stat",
            "id",
            "uname",
            "nix-store",
        }:
            script = self.bin / command
            script.write_text(f"#!{sys.executable}\n{MOCK}")
            script.chmod(0o700)
        self.system = self.root / "fixture-nixos-system-homeassistant-test"
        (self.system / "bin").mkdir(parents=True)
        (self.system / "system").write_text("aarch64-linux")
        switch = self.system / "bin/switch-to-configuration"
        switch.touch()
        switch.chmod(0o700)
        self.trace = self.root / "trace"
        self.disks_file = self.root / "disks.json"
        self.disks = {
            "/dev/nvme9n1": self.disk("/dev/nvme9n1", "CANDIDATE", "259:90"),
            "/dev/nvme8n1": self.disk("/dev/nvme8n1", "ORIGINAL", "259:80"),
        }
        self.inventory = self.root / "inventory.json"
        self.inventory.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "disk": {"serial": "ORIGINAL", "wwn": "wwn-ORIGINAL"},
                }
            )
        )
        self.inventory.chmod(0o600)

    @staticmethod
    def disk(path, serial, number):
        return {
            "path": path,
            "type": "disk",
            "serial": serial,
            "wwn": f"wwn-{serial}",
            "maj:min": number,
            "size": 500_000_000_000,
            "model": "Fixture SSD",
            "ro": False,
        }

    def invoke(self, *extra, detached=False, **settings):
        self.disks_file.write_text(json.dumps(self.disks))
        arguments = [
            "--target-disk",
            "/dev/nvme9n1",
            "--target-identity",
            "serial:CANDIDATE",
            "--system",
            str(self.system),
        ]
        arguments.extend(
            ["--preserve-identity", str(self.inventory)]
            if detached
            else ["--preserve-disk", "/dev/nvme8n1"]
        )
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "INSTALL_DISKS": str(self.disks_file),
            "INSTALL_TRACE": str(self.trace),
            **settings,
        }
        return subprocess.run(
            ["bash", str(SOURCE), *arguments, *extra],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def calls(self):
        return (
            [json.loads(line) for line in self.trace.read_text().splitlines()]
            if self.trace.exists()
            else []
        )

    def rejected(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertEqual(self.calls(), [])

    def test_inspection_prints_plan_without_writes_for_connected_and_removed_original(
        self,
    ):
        for detached in [False, True]:
            with self.subTest(detached=detached):
                result = self.invoke(detached=detached)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("HA_FIRMWARE /dev/nvme9n1p1", result.stdout)
                self.assertIn("HA_NIXOS /dev/nvme9n1p2", result.stdout)
                self.assertIn("nixos-install --root /mnt/ha-candidate", result.stdout)
                self.assertIn(
                    "mklabel msdos mkpart primary fat32 8MiB 1032MiB set 1 lba off "
                    "mkpart primary ext4 1032MiB 100% set 2 boot on",
                    result.stdout,
                )
                self.assertEqual(self.calls(), [])

    def test_expected_candidate_identifier_is_required(self):
        self.rejected(
            self.invoke("--target-identity", "serial:WRONG"), "SERIAL differs"
        )

    def test_same_device_alias_and_same_physical_identity_are_protected(self):
        self.disks["/dev/nvme8n1"]["maj:min"] = "259:90"
        self.rejected(self.invoke(), "same block device")
        self.disks["/dev/nvme8n1"] = self.disk("/dev/nvme8n1", "CANDIDATE", "259:80")
        self.rejected(self.invoke(), "protected original media")

    def test_all_captured_boot_and_data_media_are_protected(self):
        self.inventory.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "disk": {"serial": "ORIGINAL"},
                    "protected_disks": [{"serial": "CANDIDATE"}],
                }
            )
        )
        self.rejected(self.invoke(detached=True), "protected original media")

    def test_missing_drive_identity_has_precise_hardware_remedy(self):
        self.disks["/dev/nvme9n1"].update(serial=None, wwn=None)
        self.rejected(self.invoke(), "adapter that forwards the drive identifier")

    def test_mounted_swap_readonly_and_probe_failure_reject_before_writes(self):
        for mounts in ["/already-mounted", "[SWAP]"]:
            self.rejected(self.invoke(INSTALL_MOUNTS=mounts), "mounted or used as swap")
        self.rejected(
            self.invoke(INSTALL_PROBE_FAIL="1"), "cannot inspect candidate mount"
        )
        self.disks["/dev/nvme9n1"]["ro"] = True
        self.rejected(self.invoke(), "read-only")

    def test_active_mapper_is_rejected(self):
        self.rejected(
            self.invoke(INSTALL_TYPES="disk\npart\ncrypt"), "device-mapper/RAID"
        )

    def test_protected_capture_requires_root_ownership_and_private_permissions(self):
        self.rejected(self.invoke(detached=True, INSTALL_OWNER="1000"), "root-owned")
        self.rejected(
            self.invoke(detached=True, INSTALL_MODE="644"), "deny group/other"
        )

    def test_x86_or_invalid_store_system_is_rejected(self):
        (self.system / "system").write_text("x86_64-linux")
        self.rejected(self.invoke(), "aarch64-linux")
        (self.system / "system").write_text("aarch64-linux")
        self.rejected(self.invoke(INSTALL_STORE_STATUS="1"), "valid immutable store")

    def test_unsafe_mount_and_non_arm_installer_never_execute(self):
        self.rejected(
            self.invoke("--mount", "/mnt/candidate/.."), "dedicated directory"
        )
        self.rejected(
            self.invoke("--execute", INSTALL_ARCH="x86_64"), "ARM64 Pi installer"
        )

    def test_wrong_partition_parent_stops_before_formatting(self):
        result = self.invoke("--execute", INSTALL_PARENT="nvme8n1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not belong", result.stderr)
        self.assertFalse(any(call[0].startswith("mkfs") for call in self.calls()))

    def test_execution_targets_candidate_only_and_cleans_mounts_on_install_failure(
        self,
    ):
        result = self.invoke("--execute")
        self.assertEqual(result.returncode, 47, result.stderr)
        calls = self.calls()
        self.assertEqual(calls[0], ["wipefs", "--all", "--force", "/dev/nvme9n1"])
        self.assertIn(
            ["mkfs.vfat", "-F", "32", "-n", "HA_FIRMWARE", "/dev/nvme9n1p1"], calls
        )
        self.assertIn(["mkfs.ext4", "-F", "-L", "HA_NIXOS", "/dev/nvme9n1p2"], calls)
        self.assertEqual(
            calls[-2:],
            [
                ["umount", "/mnt/ha-candidate/boot/firmware"],
                ["umount", "/mnt/ha-candidate"],
            ],
        )
        self.assertNotIn("/dev/nvme8n1", json.dumps(calls))


if __name__ == "__main__":
    unittest.main()
