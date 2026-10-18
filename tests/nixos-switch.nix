# VM test of nixos-switch (modules/system/nixos/nixos-switch.nix): a failed
# activation returns to the exact prior generation, running system and boot
# loader, and a commit off main is refused.
#   nix build .#checks.x86_64-linux.nixos-switch
#
# The VM reaches neither GitHub nor a builder, so it activates a prebuilt
# toplevel with the activation `nixos-switch switch` runs after its build, and
# takes its commits from a repository it makes itself.
{ inputs, pkgs }:
inputs.nixpkgs.lib.nixos.runTest {
  name = "nixos-switch";
  hostPkgs = pkgs;

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [ ../modules/system/nixos/nixos-switch.nix ];

      # the ESP the test makes, for the boot loader the rollback restores
      virtualisation.emptyDiskImages = [ 512 ];
      boot.loader.systemd-boot.enable = true;

      my.nixosSwitch = {
        enable = true;
        repository = "file:///tmp/origin.git";
      };
      # a builder, which the VM cannot reach
      nix = {
        distributedBuilds = true;
        buildMachines = [
          {
            hostName = "reaper";
            sshUser = "nixbuild";
            system = "x86_64-linux";
            protocol = "ssh";
          }
        ];
      };
      environment.systemPackages = [
        pkgs.git
        pkgs.gptfdisk
        pkgs.dosfstools
      ];

      # a unit that fails to start, so switching to it fails
      specialisation.broken.configuration.systemd.services.broken = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${pkgs.coreutils}/bin/false";
        };
      };
    };

  testScript =
    { nodes, ... }:
    let
      toplevel = nodes.machine.system.build.toplevel;
      broken = nodes.machine.specialisation.broken.configuration.system.build.toplevel;
      activate = pkgs.lib.getExe nodes.machine.system.build.nixosSwitchActivate;
    in
    ''
      def state():
          """The generation, the running system and the boot loader's default and entries."""
          return machine.succeed(
              "readlink /nix/var/nix/profiles/system"
              " && readlink -f /run/current-system"
              " && grep ^default /boot/loader/loader.conf"
              " && cd /boot/loader/entries && sha256sum *"
          )


      machine.wait_for_unit("multi-user.target")
      # generation 1, the booted system, installed with its boot loader on a new ESP
      machine.succeed(
          "sgdisk --new=1:0:0 --typecode=1:EF00 /dev/vdb",
          "udevadm settle",
          "mkfs.vfat /dev/vdb1",
          "mkdir -p /boot && mount /dev/vdb1 /boot",
          "nix-env --profile /nix/var/nix/profiles/system --set ${toplevel}",
          "NIXOS_INSTALL_BOOTLOADER=1 ${toplevel}/bin/switch-to-configuration boot",
      )
      before = state()

      with subtest("a failed activation returns to the exact prior state"):
          status, output = machine.execute(
              "systemd-run --unit=nixos-switch --service-type=exec --collect --wait --quiet ${activate} ${broken}"
          )
          assert status == 1, output
          assert state() == before, "the rollback changed the generation, the running system or the boot loader"
          machine.fail("test -e /nix/var/nix/profiles/system-2-link")

      with subtest("a commit off main is refused"):
          machine.succeed("""
            set -eu
            export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test
            git init --quiet --initial-branch=main /tmp/work
            git -C /tmp/work commit --quiet --allow-empty -m main
            git -C /tmp/work switch --quiet --create side
            git -C /tmp/work commit --quiet --allow-empty -m side
            git -C /tmp/work rev-parse HEAD > /tmp/side
            git clone --quiet --bare /tmp/work /tmp/origin.git
          """)
          status, output = machine.execute("nixos-switch switch $(cat /tmp/side) 2>&1")
          assert status == 1 and "is not on main" in output, output
          assert state() == before
    '';
}
