# Only bless a counted boot once the machine is accessible on its LAN.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  bootCounting =
    config.boot.loader.systemd-boot.bootCounting.enable
    || (config.boot.lanzaboote.bootCounting.initialTries or 0) > 0;
  lanAddress = config.my.hosts.${config.networking.hostName}.lanIp;
in
{
  config = lib.mkIf bootCounting {
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

    # Upstream systemd-bless-boot.service requires this target. Do not use the
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
  };
}
