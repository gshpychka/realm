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
  accessScript = socket: users: ''
    # Type=simple starts before the daemon has necessarily bound its socket.
    for _ in $(seq 1 100); do
      if [ -S ${lib.escapeShellArg socket} ]; then
        ${lib.concatMapStringsSep "\n" (
          user: "setfacl -m ${lib.escapeShellArg "u:${user}:rw"} ${lib.escapeShellArg socket}"
        ) users}
        exit 0
      fi
      sleep 0.1
    done
    echo "TPM SSH agent socket did not become ready" >&2
    exit 1
  '';
  grantAccess = pkgs.writeShellApplication {
    name = "tpm-ssh-agent-grant-access";
    runtimeInputs = [
      pkgs.acl
      pkgs.coreutils
    ];
    text = accessScript cfg.socket cfg.extraUsers;
  };
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
      description = "Additional local users allowed to sign using this same TPM key; explicit socket ACLs, never the private key.";
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

    system.checks = lib.optional (cfg.extraUsers != [ ]) (
      pkgs.runCommand "tpm-ssh-agent-access-check"
        {
          nativeBuildInputs = [
            pkgs.acl
            pkgs.python3
          ];
        }
        ''
          python - <<'PY'
          import socket
          with socket.socket(socket.AF_UNIX) as agent:
              agent.bind("fixture.sock")
          PY
          chmod 600 fixture.sock
          ${accessScript "fixture.sock" [ "12345" ]}
          getfacl -cpn fixture.sock > acl.txt
          grep -qx 'user:12345:rw-' acl.txt
          grep -qx 'other::---' acl.txt
          # The initial primary-user permission must remain intact.
          grep -qx 'user::rw-' acl.txt
          touch "$out"
        ''
    );

    systemd.services.${unitName} = {
      description = "SSH agent with this host's TPM-derived key";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        ExecStart = "${lib.getExe' pkgs.ssh-tpm-agent "ssh-tpm-agent"} --no-load --hierarchy owner -l ${cfg.socket}";
        User = cfg.user;
        Group = config.users.users.${cfg.user}.group;
        SupplementaryGroups = [ config.security.tpm2.tssGroup ];
        RuntimeDirectory = unitName;
        # The socket remains private except for the explicit per-user ACLs.
        RuntimeDirectoryMode = "0711";
        ExecStartPost = lib.mkIf (cfg.extraUsers != [ ]) (lib.getExe grantAccess);
        TimeoutStartSec = 20;
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
