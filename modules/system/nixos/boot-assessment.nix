# Only bless a counted boot once the machine is accessible on its LAN.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.bootAssessment;
  systemdBootCounting =
    config.boot.loader.systemd-boot.bootCounting.enable
    || (config.boot.lanzaboote.bootCounting.initialTries or 0) > 0;
  lanAddress = config.my.hosts.${config.networking.hostName}.lanIp;
in
{
  options.my.bootAssessment.enable = lib.mkOption {
    type = lib.types.bool;
    default = systemdBootCounting;
    description = "Whether boot-complete.target, which blesses a counted boot, waits for this host to be accessible on its LAN";
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = lanAddress != null;
            message = "Boot assessment requires this host's my.hosts LAN address.";
          }
          {
            assertion = config.services.openssh.enable && !config.services.openssh.startWhenNeeded;
            message = "Boot assessment requires the SSH daemon to start at boot.";
          }
        ];

        # A counted boot is blessed once this target is reached. Do not use the
        # all-services health check: optional disks and workloads may fail safely.
        systemd.targets.boot-complete = {
          requires = [
            "sshd.service"
            "boot-lan-ready.service"
          ];
          after = [
            "sshd.service"
            "boot-lan-ready.service"
          ];
        };

        systemd.services.boot-lan-ready = {
          description = "Wait for this host's LAN address before blessing the boot";
          # Checking the registered address avoids waiting for other uplinks,
          # Tailscale, DNS, or an Internet connection via network-online.target.
          path = [
            pkgs.iproute2
            pkgs.jq
          ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            TimeoutStartSec = "2min";
          };
          script = ''
            until ip -4 -j address show scope global | jq --exit-status \
              --arg address ${lib.escapeShellArg lanAddress} \
              'any(.[].addr_info[]; .local == $address)' >/dev/null; do
              sleep 1
            done
          '';
        };
      }

      (lib.mkIf systemdBootCounting {
        # A successful boot stays assessed after its loader entry is pruned.
        systemd.services.systemd-bless-boot = {
          unitConfig.ConditionPathExists = "!/run/boot-assessment-complete";
          serviceConfig.ExecStartPost = "${pkgs.coreutils}/bin/touch /run/boot-assessment-complete";
        };
      })
    ]
  );
}
