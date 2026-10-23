# This host's SSH key, derived from its TPM's owner hierarchy and served to one
# primary user by ssh-tpm-agent (https://github.com/Foxboron/ssh-tpm-agent),
# with explicitly declared additional consumers of the same signing identity.
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
      type = lib.types.listOf lib.types.nonEmptyStr;
      default = [ ];
      description = "Additional local users allowed to sign using this same TPM key through its socket group.";
    };

    socket = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "/run/${unitName}/agent.sock";
      description = "The agent's socket, for SSH_AUTH_SOCK";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = map (user: {
      assertion = builtins.hasAttr user config.users.users;
      message = "my.tpmSshKey.extraUsers requires an existing local account: ${user}.";
    }) cfg.extraUsers;
    # makes /dev/tpmrm0 usable by the tss group
    security.tpm2.enable = true;

    users.groups.${unitName}.members = lib.unique ([ cfg.user ] ++ cfg.extraUsers);

    # ssh-tpm-agent supports LISTEN_FDS natively. Systemd creates the socket
    # with its final access policy before starting the daemon, and keeps it
    # available across daemon restarts. No post-start permission repair is needed.
    systemd.sockets.${unitName} = {
      wantedBy = [ "sockets.target" ];
      listenStreams = [ cfg.socket ];
      socketConfig = {
        SocketUser = cfg.user;
        SocketGroup = unitName;
        SocketMode = "0660";
        DirectoryMode = "0711";
        RemoveOnStop = true;
      };
    };

    systemd.services.${unitName} = {
      description = "SSH agent with this host's TPM-derived key";
      wantedBy = [ "multi-user.target" ];
      requires = [ "${unitName}.socket" ];
      after = [ "${unitName}.socket" ];
      serviceConfig = {
        ExecStart = "${lib.getExe' pkgs.ssh-tpm-agent "ssh-tpm-agent"} --no-load --hierarchy owner -l ${cfg.socket}";
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
