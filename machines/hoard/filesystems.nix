{
  config,
  lib,
  pkgs,
  utils,
  ...
}:
let
  inherit (import ./disks.nix) arrayMembers;

  deviceUnit = path: "${utils.escapeSystemdPath path}.device";

  arrayMountPoint = config.fileSystems."/mnt/hoard".mountPoint;
  arrayMountUnit = "${utils.escapeSystemdPath arrayMountPoint}.mount";
  # Services whose data lives on the array. With the enclosure absent they are
  # skipped, and they start once the array mounts and stop if it goes away.
  arrayServices = [
    "plex"
    "jellyfin"
    "sonarr"
    "radarr"
    "lidarr"
    "bazarr"
    # its only clients are the arrs above
    "prowlarr"
    # completed downloads land on the array
    "qbittorrent"
    "sabnzbd"
    "samba-smbd"
  ];
in
{
  boot = {
    initrd = {
      luks.devices = {
        oasis = {
          device = "/dev/disk/by-label/oasis-enc";
          crypttabExtraOpts = [
            "tpm2-device=auto"
            "x-systemd.device-timeout=10s"
          ];
          allowDiscards = true;
          bypassWorkqueues = true;
        };
      };
      systemd.tpm2.enable = true;
    };

    kernelParams = [
      # enable mq io schedulers
      "dm_mod.use_blk_mq=1"
      # force-enable SAT mode with UAS driver for Seagate enclosure
      # https://www.smartmontools.org/wiki/SAT-with-UAS-Linux#workaround-unset-t
      "usb-storage.quirks=0bc2:2032:"
    ];
    kernel.sysctl = {
      "kernel.task_delayacct" = "1"; # Enables task delay accounting at runtime (additional stats in e.g. iotop)
      "vm.dirty_background_ratio" = "10"; # Start flushing dirty pages when 10% of memory is dirty
      "vm.dirty_ratio" = "80"; # Force flushing dirty pages when 80% of memory is dirty
      "vm.vfs_cache_pressure" = "10"; # Something to do with storing fs metadata in memory
      "vm.dirty_writeback_centisecs" = "500"; # Writeback every 5s
      "vm.dirty_expire_centisecs" = "500"; # Expire dirty pages every 5s
    };
    tmp = {
      useTmpfs = true; # /tmp is stored in RAM
      tmpfsSize = "80%"; # /tmp can take up to 80% of RAM
    };
  };
  hardware.block = {
    defaultScheduler = "mq-deadline";
    defaultSchedulerRotational = "bfq";
  };

  environment.etc."crypttab".text = lib.concatLines (
    lib.mapAttrsToList (name: device: "${name} ${device} - tpm2-device=auto,noauto") arrayMembers
  );

  # Nothing unlocks these at boot, so each disk is unlocked here when its partition shows up.
  services.udev.extraRules = lib.concatLines (
    lib.mapAttrsToList (
      name: device:
      lib.concatStringsSep ", " [
        # the partition appearing, or udev re-reading one already present
        ''ACTION=="add|change"''
        # disks and partitions
        ''SUBSYSTEM=="block"''
        # the encrypted container, not the filesystem inside it
        ''ENV{ID_FS_TYPE}=="crypto_LUKS"''
        # the label in the LUKS header, set by `cryptsetup config --label`
        ''ENV{ID_FS_LABEL}=="${baseNameOf device}"''
        # start this unit; systemd escapes the dash in the instance name
        ''ENV{SYSTEMD_WANTS}+="systemd-cryptsetup@${utils.escapeSystemdPath name}.service"''
      ]
    ) arrayMembers
  );

  fileSystems = {
    "/" = {
      label = "nixos";
      fsType = "ext4";
      options = [ "noatime" ];
    };

    "/boot" = {
      label = "boot";
      fsType = "vfat";
      options = [
        "fmask=0077"
        "dmask=0077"
      ];
    };

    "/mnt/hoard" = {
      # On first device:
      # mkfs.btrfs -d single -m dup -L hoard -s 4096 -n 65536 --csum xxhash /dev/mapper/hoard-beta
      # On second device:
      # btrfs device add /dev/mapper/hoard-alpha /mnt/hoard
      # btrfs balance start -dconvert=raid0 -mconvert=raid1 --bg /mnt/hoard
      # btrfs filesystem label /mnt/hoard hoard
      # this will mount both drives
      label = "hoard";
      fsType = "btrfs";
      options = [
        "compress=zstd:1"
        "noatime"
        "lazytime"
        # mounts as soon as the unlocked device appears
        "x-systemd.wanted-by=${deviceUnit config.fileSystems."/mnt/hoard".device}"
      ];
    };

    "/mnt/oasis" = {
      device = "/dev/mapper/oasis";
      fsType = "ext4";
      options = [
        "noatime"
        "x-systemd.device-timeout=10s"
        "nofail"
      ];
    };
  };

  swapDevices = [ { device = "/dev/disk/by-label/swap"; } ];

  my.disk-spindown = {
    enable = true;
    devices = lib.attrValues arrayMembers;
    timeoutMinutes = 30;
  };

  services = {
    fstrim.enable = true;
    # Monthly btrfs scrubbing to detect corruption
    # We can't repair the data since it is RAID0,
    # but we can repair the metadata that's in RAID1
    btrfs.autoScrub = {
      enable = true;
      fileSystems = [
        # this is just "/mnt/hoard", but doing it this way to be a bit safer
        config.fileSystems."/mnt/hoard".mountPoint
      ];
      interval = "monthly";
    };
  };

  systemd.services =
    lib.genAttrs arrayServices (_: {
      unitConfig.ConditionPathIsMountPoint = arrayMountPoint;
      after = [ arrayMountUnit ];
      partOf = [ arrayMountUnit ];
      wantedBy = [ arrayMountUnit ];
    })
    // {
      reboot-if-hoard-is-borked = rec {
        unitConfig = {
          ConditionPathIsMountPoint = config.fileSystems."/mnt/hoard".mountPoint;
        };
        serviceConfig.Type = "oneshot";
        script = ''
          if ! ${pkgs.coreutils}/bin/touch ${unitConfig.ConditionPathIsMountPoint}/.health-check 2>/dev/null; then
            echo "Filesystem not healthy, rebooting"
            ${pkgs.systemd}/bin/systemctl --no-block reboot
          fi
        '';
      };
    };

  systemd.timers.reboot-if-hoard-is-borked =
    let
      mountUnit = "${utils.escapeSystemdPath config.fileSystems."/mnt/hoard".mountPoint}.mount";
    in
    {
      # start the timer iif the mount unit is active
      wantedBy = [ mountUnit ];
      # the timer is started after the mount (this is only about ordering)
      after = [ mountUnit ];
      # if the mount unit is stopped, the timer will be too
      partOf = [ mountUnit ];

      timerConfig = {
        # fires every minute
        OnActiveSec = "1min";
        # only fires after the unit is activated once
        OnUnitActiveSec = "1min";
        Unit = config.systemd.services.reboot-if-hoard-is-borked.name;
      };
    };

}
