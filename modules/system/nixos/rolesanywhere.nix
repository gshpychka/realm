# AWS credentials for this machine's users through IAM Roles Anywhere, from a CA in its TPM2 (packages/rolesanywhere).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.rolesanywhere;
  unitName = "rolesanywhere";
  caUnit = "${unitName}-ca";
  stateDirectory = "/var/lib/${unitName}";
  socketPath = "/run/${unitName}/certificate.sock";
  # DynamicUser= names the issuing processes' user and group after the unit,
  # and refuses to start when that group already exists
  clientGroup = "${unitName}-clients";
  # symlink in stateDirectory to the current CA's directory
  currentLink = "current";
  currentCa = "${stateDirectory}/${currentLink}";
  # file in stateDirectory whose presence asks for the CA's replacement
  replaceRequest = "replace-ca";
  # What rolesanywhere-ca writes to ${stateDirectory}/<SKI>/, each file handed
  # to the issuing process as the credential of the same name.
  caFiles = {
    # the key's public area (TPM2B_PUBLIC)
    public = "key.pub";
    # the private key, encrypted by the TPM2's storage key (TPM2B_PRIVATE)
    private = "key.priv";
    # the self-signed CA certificate, the one to register with AWS
    certificate = "ca.pem";
  };

  tpmDevice = "/dev/tpmrm0";

  issuerConfig = pkgs.writeText "${unitName}.json" (
    builtins.toJSON {
      name = config.networking.hostName;
      inherit (cfg) clients;
      certificateLifetimeSeconds = cfg.certificateLifetime;
      # interpolating a path in the configuration's source copies it to the
      # store, so the deployed machine has it
      registeredCertificate = lib.mapNullable (path: "${path}") cfg.caCertificate;
      inherit
        stateDirectory
        currentLink
        replaceRequest
        caFiles
        ;
      tpm2Tools = "${pkgs.tpm2-tools}/bin";
      # the kernel's TPM2 resource manager, which flushes whatever a process
      # loaded into the TPM2 when it exits
      tcti = "device:${tpmDevice}";
    }
  );

  package = pkgs.callPackage ../../../packages/rolesanywhere { };
  tool = lib.getExe package;

  replaceCa = pkgs.writeShellApplication {
    name = "rolesanywhere-replace-ca";
    text = ''
      # asks rolesanywhere-ca for a new CA, which then needs registering with AWS
      install -m 0600 /dev/null ${stateDirectory}/${replaceRequest}
      # runs rolesanywhere-ca, which generates the new CA
      systemctl restart ${caUnit}.service
    '';
  };

  credentials = pkgs.writeShellApplication {
    name = "rolesanywhere-credentials";
    text = ''
      # runs the client against this machine's issuer and aws_signing_helper
      exec ${lib.getExe' package "rolesanywhere-credentials"} \
        --socket ${socketPath} --unit ${unitName} \
        --helper ${lib.getExe pkgs.aws-signing-helper} "$@"
    '';
  };

  # Sandboxing shared by the CA and issuing processes.
  sandbox = {
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
in
{
  options.services.rolesanywhere = {
    enable = lib.mkEnableOption "AWS credentials for local users through IAM Roles Anywhere, from a CA in this machine's TPM2";
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
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./rolesanywhere-ca.pem";
      description = ''
        The CA certificate registered with AWS as this machine's Roles
        Anywhere trust anchor. Certificates are issued only while it is the
        machine's current CA. To register a new CA (the first one, or a
        replacement rolesanywhere-ca logs), copy
        ${currentCa}/${caFiles.certificate} from the machine into this file,
        update the trust anchor with it, and deploy.
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

    environment.systemPackages = [
      credentials
      replaceCa
    ];
    users.groups.${clientGroup}.members = cfg.clients;
    # makes ${tpmDevice} accessible to its group, tssGroup
    security.tpm2.enable = true;

    systemd.services.${caUnit} = {
      description = "IAM Roles Anywhere CA in the TPM2";
      # at boot, and on deploys that change it: RemainAfterExit keeps it
      # active, so switching restarts it
      wantedBy = [ "multi-user.target" ];
      serviceConfig = sandbox // {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${tool} ca ${issuerConfig}";
        # root's, readable by all: the CA certificate is public
        StateDirectory = unitName;
        StateDirectoryMode = "0755";
        # a tmpfs, for the TPM2 context files
        RuntimeDirectory = caUnit;
        RuntimeDirectoryMode = "0700";
        PrivateTmp = true;
      };
    };

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
      unitConfig = {
        # instances of failed refusals would otherwise pile up in `systemctl --failed`
        CollectMode = "inactive-or-failed";
        # rolesanywhere-ca creates the first CA
        ConditionPathExists = currentCa;
      };
      serviceConfig = sandbox // {
        ExecStart = "${tool} serve ${issuerConfig}";
        StandardInput = "socket";
        # the connection carries the reply alone; logs go to the journal
        StandardOutput = "journal";
        StandardError = "journal";
        LoadCredential = map (name: "${name}:${currentCa}/${name}") (lib.attrValues caFiles);
        # bounds a stuck instance; a normal one answers in about a second,
        # but a slow TPM2 can take several
        RuntimeMaxSec = 30;
        DynamicUser = true;
        # SO_PEERCRED reports each caller's real UID only outside a user namespace
        PrivateUsers = false;
        SupplementaryGroups = [ config.security.tpm2.tssGroup ];
      };
    };
  };
}
