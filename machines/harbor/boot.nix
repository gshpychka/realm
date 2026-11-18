# A new default system boots as a counted trial and becomes the known-good
# system once it reaches boot-complete.target. A trial that runs out of tries
# makes U-Boot boot the known-good system, which becomes the default again.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  extlinux = config.boot.loader.generic-extlinux-compatible;

  systemProfile = "/nix/var/nix/profiles/system";
  # GC root of the last system that reached boot-complete.target
  knownGood = "/nix/var/nix/profiles/known-good";
  # extlinux menu with the known-good system as its only entry
  knownGoodMenu = "/boot/known-good";

  firmwareMount = config.hardware.raspberry-pi.firmware.path;
  # U-Boot's environment on the FIRMWARE partition, carrying the trial's boot count
  envFile = "bootcount.env";
  envSize = "0x4000";
  fwEnvConfig = pkgs.writeText "fw_env.config" "${firmwareMount}/${envFile} 0x0 ${envSize}\n";

  # Writes the boot menus for the default system given as its argument, and arms
  # that system's trial while it differs from the known-good system.
  installBootMenus = pkgs.writeShellApplication {
    name = "install-boot-menus";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.ubootTools
    ];
    text = ''
      # the system the default menu boots
      default=$(readlink -f "$1")
      # the known-good system, empty before the first healthy boot
      known_good=$(readlink -e ${knownGood} || true)

      # writes the default menu
      ${extlinux.populateCmd} -d /boot -c "$default"
      # whether a known-good system exists
      if [[ -n $known_good ]]; then
        # writes the known-good menu; this -g overrides the generation count in populateCmd
        ${extlinux.populateCmd} -g 0 -d ${knownGoodMenu} -c "$known_good"
      fi

      # whether the default awaits its trial
      if [[ -n $known_good && $default != "$known_good" ]]; then
        # U-Boot counts boots from zero
        uboot_env=$'upgrade_available=1\nbootcount=0'
      else
        # U-Boot boots without counting
        uboot_env=upgrade_available=0
      fi
      # U-Boot imports only these variables from the file
      mkenvimage -s ${envSize} -o ${firmwareMount}/${envFile}.new - <<<"$uboot_env"
      # replaces the environment in one rename
      mv -f ${firmwareMount}/${envFile}.new ${firmwareMount}/${envFile}
      # flushes the FIRMWARE partition
      sync --file-system ${firmwareMount}/${envFile}
    '';
  };
in
{
  # nixos-hardware doesn't have a binary cache, so the kernel is build from source
  # we use the generic kernel from nixpkgs instead
  # https://github.com/NixOS/nixos-hardware/issues/325
  boot.kernelPackages = pkgs.linuxPackages;
  # the generic kernel boots with the device trees built from its own source
  boot.loader.generic-extlinux-compatible.useGenerationDeviceTree = true;

  # a kernel panic, or a failure in stage 1, reboots after 10 seconds
  boot.kernelParams = [
    "panic=10"
    "boot.panic_on_fail"
  ];
  # the BCM2835 watchdog's longest timeout; a hung kernel or PID 1 resets the board
  systemd.settings.Manager.RuntimeWatchdogSec = "15s";

  # The SD image writes this U-Boot to the FIRMWARE partition. A running system
  # doesn't rewrite it, since a boot chain rewritten in place can't fall back.
  # To update it in place, copy u-boot.bin over the file config.txt's kernel= loads:
  #   nix build .#nixosConfigurations.harbor.config.hardware.raspberry-pi.firmware.uboot.package
  hardware.raspberry-pi.firmware.uboot = {
    enable = true;
    package = pkgs.ubootRaspberryPiAarch64.override {
      extraConfig = ''
        CONFIG_BOOTCOUNT_LIMIT=y
        CONFIG_BOOTCOUNT_ENV=y
        CONFIG_BOOTCOUNT_BOOTLIMIT=2
        CONFIG_CMD_SYSBOOT=y
        # boots the known-good menu from the SD image's root partition, or the default menu when it is missing
        CONFIG_BOOTCOUNT_ALTBOOTCMD="sysboot mmc 0:2 any ''${scriptaddr} ${knownGoodMenu}/extlinux/extlinux.conf; run bootcmd"
        # U-Boot built without the writeable list imports a stored environment whole,
        # so the two-variable file has a name only this build reads
        CONFIG_ENV_FAT_FILE="${envFile}"
        CONFIG_ENV_SIZE=${envSize}
        # the stored environment contributes only the trial's variables
        CONFIG_ENV_WRITEABLE_LIST=y
        CONFIG_ENV_FLAGS_LIST_STATIC="bootcount:dw,upgrade_available:dw"
      '';
    };
  };

  # the SD image's FIRMWARE partition, mounted on access and released when idle
  fileSystems.${firmwareMount} = {
    device = "/dev/disk/by-label/FIRMWARE";
    fsType = "vfat";
    options = [
      "x-systemd.automount"
      "x-systemd.idle-timeout=1min"
    ];
  };

  system.build.installBootLoader = lib.mkForce (lib.getExe installBootMenus);

  my.bootAssessment.enable = true;

  systemd.targets.boot-complete = {
    requires = [ config.systemd.services.dnsmasq.name ];
    after = [ config.systemd.services.dnsmasq.name ];
  };

  systemd.services.bless-known-good = {
    description = "Record a healthy boot's system as the known-good system";
    requires = [ "boot-complete.target" ];
    after = [ "boot-complete.target" ];
    wantedBy = [ "multi-user.target" ];
    path = [
      pkgs.coreutils
      pkgs.ubootTools
      config.nix.package
      installBootMenus
      config.my.notifications.package
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      # the system this boot runs
      booted=$(readlink -f /run/booted-system)
      # the system the default menu boots
      default=$(readlink -f ${systemProfile})
      # the known-good system, empty before the first healthy boot
      known_good=$(readlink -e ${knownGood} || true)
      # the boots U-Boot counted for the trial, empty when the trial is disarmed
      count=$(fw_printenv -c ${fwEnvConfig} -n bootcount 2>/dev/null || true)

      # whether the default has yet to reach a healthy boot
      if [[ $default != "$known_good" ]]; then
        # points a fresh link at this boot's system
        ln -sfnT "$booted" ${knownGood}.new
        # makes this boot's system the known-good one in one rename
        mv -fT ${knownGood}.new ${knownGood}
        # whether this boot ran the default
        if [[ $booted == "$default" ]]; then
          # rewrites the known-good menu and disarms the trial
          install-boot-menus "$booted"
          # whether U-Boot left an armed trial uncounted
          if [[ -n $known_good ]] && ((''${count:-0} == 0)); then
            # reports that the SD card's U-Boot lacks boot counting
            notify -p 4 -t warning "Boot trial uncounted" "U-Boot did not count the trial boot of $booted; update U-Boot on the SD card to enable the fallback."
          fi
        else
          # makes this boot's system the default again
          nix-env --profile ${systemProfile} --set "$booted"
          # rewrites both menus and disarms the trial
          install-boot-menus "$booted"
          # reports the failed trial
          notify -p 4 -t warning "Boot fell back" "$default failed its trial boots; $booted is the default again."
        fi
      fi
    '';
  };

  # a counted trial boot short of boot-complete.target after 10 minutes reboots into its next try
  systemd.timers.boot-trial-deadline = {
    wantedBy = [ "timers.target" ];
    timerConfig.OnBootSec = "10min";
  };

  systemd.services.boot-trial-deadline = {
    description = "Reboot a trial boot that has not become known-good";
    path = [
      pkgs.coreutils
      pkgs.ubootTools
      config.systemd.package
    ];
    serviceConfig.Type = "oneshot";
    script = ''
      # the boots U-Boot counted for the trial, empty when the trial is disarmed
      count=$(fw_printenv -c ${fwEnvConfig} -n bootcount 2>/dev/null || true)
      # whether U-Boot counted this boot and this boot runs the default
      if ((''${count:-0} > 0)) && [[ $(readlink -f /run/booted-system) == "$(readlink -f ${systemProfile})" ]]; then
        # starts the trial's next try
        systemctl reboot
      fi
    '';
  };
}
