# This host's SSH key, derived from its TPM's owner hierarchy and served to
# local users by ssh-tpm-agent (https://github.com/Foxboron/ssh-tpm-agent).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.tpmSshKey;
  unitName = "tpm-ssh-agent";
in
{
  options.my.tpmSshKey = {
    enable = lib.mkEnableOption "this host's TPM-derived SSH key";

    user = lib.mkOption {
      type = lib.types.str;
      description = "User the key is served to";
    };

    extraUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Further users the key is served to";
    };

    socket = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "/run/${unitName}/agent.sock";
      description = "The agent's socket, for SSH_AUTH_SOCK";
    };
  };

  config = lib.mkIf cfg.enable {
    # makes /dev/tpmrm0 usable by the tss group
    security.tpm2.enable = true;

    # the socket's group, which extraUsers connect through
    users.groups.${unitName}.members = cfg.extraUsers;

    # created by systemd with the group's access, and passed to ssh-tpm-agent (LISTEN_FDS)
    systemd.sockets.${unitName} = {
      wantedBy = [ "sockets.target" ];
      listenStreams = [ cfg.socket ];
      socketConfig = {
        SocketUser = cfg.user;
        SocketGroup = unitName;
        SocketMode = "0660";
      };
    };

    systemd.services.${unitName} = {
      description = "SSH agent with this host's TPM-derived key";
      # started at boot: the agent answers requests before it has derived its keys
      wantedBy = [ "multi-user.target" ];
      requires = [ "${unitName}.socket" ];
      after = [ "${unitName}.socket" ];
      serviceConfig = {
        ExecStart = "${lib.getExe' pkgs.ssh-tpm-agent "ssh-tpm-agent"} --no-load --hierarchy owner";
        User = cfg.user;
        Group = config.users.users.${cfg.user}.group;
        SupplementaryGroups = [ config.security.tpm2.tssGroup ];
        UMask = "0077";
        Restart = "on-failure";
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
        RestrictSUIDSGID = true;
      };
    };
  };
}
