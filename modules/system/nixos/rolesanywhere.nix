# AWS credentials for this machine's users through IAM Roles Anywhere, from a CA key in its TPM2 (packages/rolesanywhere).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.rolesanywhere;
  unitName = "rolesanywhere";
  socketPath = "/run/${unitName}/certificate.sock";
  # DynamicUser= names the issuing processes' user and group after the unit,
  # and refuses to start when that group already exists
  clientGroup = "${unitName}-clients";
  tpmDevice = "/dev/tpmrm0";

  package = pkgs.callPackage ../../../packages/rolesanywhere { };

  issuerConfig = pkgs.writeText "${unitName}.json" (
    builtins.toJSON {
      name = config.networking.hostName;
      inherit (cfg) clients;
      certificateLifetimeSeconds = cfg.certificateLifetime;
      # interpolating a path in the configuration's source copies it to the
      # store, so the deployed machine has it
      caCertificate = "${cfg.caCertificate}";
    }
  );

  credentials = pkgs.writeShellApplication {
    name = "rolesanywhere-credentials";
    text = ''
      # runs the client against this machine's issuer and aws_signing_helper
      exec ${lib.getExe' package "rolesanywhere-credentials"} \
        --socket ${socketPath} --unit ${unitName} \
        --helper ${lib.getExe pkgs.aws-signing-helper} "$@"
    '';
  };
in
{
  options.services.rolesanywhere = {
    enable = lib.mkEnableOption "AWS credentials for local users through IAM Roles Anywhere, from a CA key in this machine's TPM2";
    clients = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "alice" ];
      description = ''
        Unix users that may get a certificate for themselves, with subject
        "<hostname>:<user>". A new member's group applies from their next login.
      '';
    };
    caCertificate = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./rolesanywhere-ca.pem";
      description = ''
        The CA certificate registered with AWS as this machine's Roles
        Anywhere trust anchor. `rolesanywhere ca-certificate`, run as root on
        the machine, prints one. After a Secure Boot (PCR 7) change or a TPM2
        clear, the machine's CA key changes, and certificates are refused
        until its new CA certificate is registered.
      '';
    };
    certificateLifetime = lib.mkOption {
      type = lib.types.ints.between 60 3600;
      default = 300;
      description = ''
        Seconds a client certificate stays valid. A certificate is traded for
        AWS credentials once, right after it is issued, so this only bounds
        how long a leaked certificate and key are useful.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all (user: config.users.users ? ${user}) cfg.clients;
        message = "services.rolesanywhere.clients must name users.users entries.";
      }
    ];

    environment.systemPackages = [ credentials ];
    users.groups.${clientGroup}.members = cfg.clients;
    # makes ${tpmDevice} accessible to its group, tssGroup
    security.tpm2.enable = true;

    # One sandboxed process per connection.
    systemd.sockets.${unitName} = {
      description = "IAM Roles Anywhere certificate issuer";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = socketPath;
        Accept = true;
        SocketUser = "root";
        SocketGroup = clientGroup;
        SocketMode = "0660";
        # bounds the instances a looping client can spawn; on a Unix
        # socket the per-source limit applies per peer UID
        MaxConnections = 16;
        MaxConnectionsPerSource = 4;
        RemoveOnStop = true;
      };
    };

    systemd.services."${unitName}@" = {
      description = "IAM Roles Anywhere certificate issuer, one connection";
      # instances of failed refusals would otherwise pile up in `systemctl --failed`
      unitConfig.CollectMode = "inactive-or-failed";
      serviceConfig = {
        ExecStart = "${lib.getExe package} serve ${issuerConfig}";
        StandardInput = "socket";
        # the connection carries the reply alone; logs go to the journal
        StandardOutput = "journal";
        StandardError = "journal";
        # bounds a stuck instance; a normal one answers in about a second,
        # but a slow TPM2 can take several
        RuntimeMaxSec = 30;
        DynamicUser = true;
        # SO_PEERCRED reports each caller's real UID only outside a user namespace
        PrivateUsers = false;
        SupplementaryGroups = [ config.security.tpm2.tssGroup ];
        PrivateNetwork = true;
        IPAddressDeny = "any";
        RestrictAddressFamilies = "AF_UNIX";
        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        # The TPM2 resource manager is the only device. Access to it grants the
        # whole TPM2 (other keys, extending PCRs), which is why nothing a caller
        # sends is ever read.
        PrivateDevices = true;
        BindPaths = [ tpmDevice ];
        DeviceAllow = [ "${tpmDevice} rw" ];
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        ProcSubset = "pid";
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged @resources"
        ];
        UMask = "0077";
      };
    };
  };
}
