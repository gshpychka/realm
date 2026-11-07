# A TPM-sealed SSH key served only to Hermes.
#
# Provision on hoard and record the public key in my.sshKeys.hermes:
#   sudo install -d -m 0700 /var/lib/hermes-ssh-agent
#   sudo ssh-tpm-keygen -t ecdsa -b 256 -N '' -C hermes@hoard -f /var/lib/hermes-ssh-agent/id_ecdsa
{
  config,
  lib,
  pkgs,
  ...
}:
let
  service = config.services.hermes-agent;
  unitName = "hermes-ssh-agent";
in
{
  config = lib.mkIf service.enable {
    security.tpm2.enable = true;
    environment.systemPackages = [ pkgs.ssh-tpm-agent ];

    systemd.services = {
      ${unitName} = {
        description = "SSH agent with Hermes's TPM-sealed key";
        wantedBy = [ "multi-user.target" ];
        preStart = "test -f /var/lib/${unitName}/id_ecdsa.tpm";
        postStart = ''
          until SSH_AUTH_SOCK=${config.my.hermes-agent.root.agentSocket} ${lib.getExe' pkgs.openssh "ssh-add"} -l >/dev/null 2>&1; do
            sleep 0.1
          done
        '';
        serviceConfig = {
          ExecStart = "${lib.getExe' pkgs.ssh-tpm-agent "ssh-tpm-agent"} --key-dir /var/lib/${unitName} -l ${config.my.hermes-agent.root.agentSocket}";
          User = service.user;
          Group = service.group;
          SupplementaryGroups = [ config.security.tpm2.tssGroup ];
          StateDirectory = unitName;
          StateDirectoryMode = "0700";
          RuntimeDirectory = unitName;
          RuntimeDirectoryMode = "0700";
          UMask = "0077";
          Restart = "on-failure";
          TimeoutStartSec = 30;
          DevicePolicy = "closed";
          DeviceAllow = [ "/dev/tpmrm0 rw" ];
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          PrivateNetwork = true;
          RestrictAddressFamilies = [ "AF_UNIX" ];
          CapabilityBoundingSet = "";
          SystemCallFilter = [ "@system-service" ];
          SystemCallArchitectures = "native";
          MemoryDenyWriteExecute = true;
          LockPersonality = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictNamespaces = true;
        };
      };

    }
    // lib.genAttrs config.my.hermes-agent.units (_: {
      requires = [ "${unitName}.service" ];
      after = [ "${unitName}.service" ];
    });
  };
}
