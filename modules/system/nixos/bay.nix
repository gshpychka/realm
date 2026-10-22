# Bay's host platform: Incus and its Bay project, the session image and warm base, the Bay server and the gateway.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.bay;
  inherit (lib) mkOption types;
  json = pkgs.formats.json { };
  yaml = pkgs.formats.yaml { };

  bay = cfg.package;
  image = import ../../../packages/bay/image.nix {
    inherit pkgs bay;
    incus = config.virtualisation.incus.package;
    inherit (cfg.guest) modules;
  };

  project = "bay";
  pool = "bay";
  bridge = "baybr0";
  acl = "bay-sessions";
  base = "base";
  apiSocket = "/run/bay/bay.sock";
  identitySocket = "/run/bay/identity.sock";
  gatewaySocket = "/run/bay-gateway/operator.sock";
  bridgeAddress = builtins.head (lib.splitString "/" cfg.network.address);

  machines = lib.mapAttrs (_: import ../../../packages/bay/machine.nix) cfg.machines;
  # Aliases with the same image and resources share one immutable warm base. Preparing
  # them sequentially avoids booting every agent's full memory reservation at once.
  bases = lib.listToAttrs (
    lib.mapAttrsToList (name: machine: {
      name = machines.${name}.base;
      value = { inherit name machine; };
    }) cfg.machines
  );

  serverConfig = json.generate "bay-server.json" {
    incusSocket = "/var/lib/incus/unix.socket";
    inherit project base gatewaySocket;
    records = "/var/lib/bay/sessions";
    mirrors = "/var/lib/bay/mirrors";
    inherit (cfg) mirrorRefresh;
    inherit (cfg.sessions) maxRunning maxMemory;
    inherit machines;
    programs = lib.mapAttrs (_: p: {
      inherit (p)
        command
        resume
        connect
        machine
        maxConnections
        history
        monitor
        ;
    }) cfg.programs;
  };

  gatewayConfig = json.generate "bay-gateway.json" (
    {
      inherit identitySocket;
      database = "/var/lib/bay-gateway/messages.db";
    }
    // lib.optionalAttrs (cfg.notifications != null) {
      ntfy = { inherit (cfg.notifications) url topic; };
    }
  );

  # IPv4 outside 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16 and 224/3. Incus ACLs apply
  # drop rules before allow rules and DHCP renewals target the bridge's private address, so the public internet
  # is an allow-list.
  publicIPv4 = [
    "1.0.0.0/8"
    "2.0.0.0/7"
    "4.0.0.0/6"
    "8.0.0.0/7"
    "11.0.0.0/8"
    "12.0.0.0/6"
    "16.0.0.0/4"
    "32.0.0.0/3"
    "64.0.0.0/3"
    "96.0.0.0/6"
    "100.0.0.0/10"
    "100.128.0.0/9"
    "101.0.0.0/8"
    "102.0.0.0/7"
    "104.0.0.0/5"
    "112.0.0.0/5"
    "120.0.0.0/6"
    "124.0.0.0/7"
    "126.0.0.0/8"
    "128.0.0.0/3"
    "160.0.0.0/5"
    "168.0.0.0/8"
    "169.0.0.0/9"
    "169.128.0.0/10"
    "169.192.0.0/11"
    "169.224.0.0/12"
    "169.240.0.0/13"
    "169.248.0.0/14"
    "169.252.0.0/15"
    "169.255.0.0/16"
    "170.0.0.0/7"
    "172.0.0.0/12"
    "172.32.0.0/11"
    "172.64.0.0/10"
    "172.128.0.0/9"
    "173.0.0.0/8"
    "174.0.0.0/7"
    "176.0.0.0/4"
    "192.0.0.0/9"
    "192.128.0.0/11"
    "192.160.0.0/13"
    "192.169.0.0/16"
    "192.170.0.0/15"
    "192.172.0.0/14"
    "192.176.0.0/12"
    "192.192.0.0/10"
    "193.0.0.0/8"
    "194.0.0.0/7"
    "196.0.0.0/6"
    "200.0.0.0/5"
    "208.0.0.0/4"
  ];

  aclConfig = yaml.generate "bay-acl.yaml" {
    description = "Sessions reach the public internet and the bridge's DHCP server";
    egress =
      # Incus applies reject rules before allow rules, and a rule without a destination matches every address
      lib.optional (cfg.network.blockedAddresses != [ ]) {
        action = "reject";
        destination = lib.concatStringsSep "," cfg.network.blockedAddresses;
        state = "enabled";
      }
      ++ [
        {
          action = "allow";
          destination = lib.concatStringsSep "," publicIPv4;
          state = "enabled";
        }
        # DHCP discovery is admitted for every NIC; renewals go to the bridge address
        {
          action = "allow";
          destination = "${bridgeAddress}/32";
          protocol = "udp";
          destination_port = "67";
          state = "enabled";
        }
      ];
    ingress = [ ];
  };

  profileConfig = yaml.generate "bay-profile.yaml" {
    description = "Bay sessions";
    config = {
      "limits.cpu" = toString cfg.sessions.cpus;
      "limits.memory" = "${toString cfg.sessions.memory}GiB";
      "migration.stateful" = "true";
      # running sessions are suspended at host shutdown and resumed at boot
      "boot.host_shutdown_action" = "stateful-stop";
      "security.guestapi" = "false";
      "security.nesting" = "false";
      # the image boots an unsigned systemd-boot
      "security.secureboot" = "false";
    };
    devices = {
      root = {
        type = "disk";
        path = "/";
        inherit pool;
        size = "${toString cfg.sessions.disk}GiB";
        # holds the saved memory of a suspended session
        "size.state" = "${toString (cfg.sessions.memory + 1)}GiB";
      };
      eth0 = {
        type = "nic";
        network = bridge;
        name = "eth0";
        "security.acls" = acl;
        "security.acls.default.egress.action" = "reject";
        "security.acls.default.ingress.action" = "drop";
        "security.port_isolation" = "true";
        "security.ipv4_filtering" = "true";
        "security.ipv6_filtering" = "true";
        "security.mac_filtering" = "true";
      };
    };
  };

  programType = types.submodule {
    options = {
      command = mkOption {
        type = types.nonEmptyListOf types.str;
        description = "Command line that launches the program.";
      };
      resume = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Command line that continues the program from its history, restored from the record or left on the instance's disk, and copes with a home that holds none; empty reuses `command`.";
      };
      connect = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = ''
          Predefined command run as the session user to connect the operator to a persistent program over
          stdin and stdout. Disconnecting stops this connector, not the program. Empty disables the program
          connection; terminal attachment remains available.
        '';
      };
      machine = mkOption {
        type = types.str;
        default = "default";
        description = "Declared machine this program runs in; its image and resource revision are pinned when a session is created.";
      };
      maxConnections = mkOption {
        type = types.ints.positive;
        default = 1;
        description = "Maximum simultaneous connections to the program's predefined connector.";
      };
      history = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = ''
          Paths, relative to the program's home, holding the program's history. Ending a session saves them
          into its record, so they must never hold credential files.
        '';
      };
      monitor = mkOption {
        type = types.bool;
        default = true;
        description = "Alert the operator on a terminal bell or a long silence; programs that alert through hooks turn it off.";
      };
    };
  };
in
{
  options.services.bay = {
    enable = lib.mkEnableOption "Bay, isolated VM sessions for terminal programs";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../../packages/bay { };
      defaultText = lib.literalExpression "pkgs.callPackage ../../../packages/bay { }";
      description = "Bay binaries used by the host and its session image.";
    };

    operator = mkOption {
      type = types.str;
      description = "The user who drives Bay: the only user who can reach its API, and who attaches to sessions.";
    };

    storage = {
      dataset = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "tank/bay";
        description = ''
          Empty ZFS pool or dataset that sessions live on; null keeps them in a loop file of `storage.size`. Either
          choice is fixed once Bay first activates.
        '';
      };
      size = mkOption {
        type = types.str;
        default = "200GiB";
        description = "Size of the loop file sessions live on without `storage.dataset`; it can grow but not shrink.";
      };
    };

    network.address = mkOption {
      type = types.str;
      example = "10.80.0.1/24";
      description = "Address and subnet of the bridge sessions attach to.";
    };

    network.blockedAddresses = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "203.0.113.7" ];
      description = ''
        Public IPv4 addresses and subnets sessions must not reach, such as the site's own public address, which a
        router can lead back into the LAN.
      '';
    };

    sessions = {
      cpus = mkOption {
        type = types.ints.positive;
        default = 4;
        description = "vCPUs per session.";
      };
      memory = mkOption {
        type = types.ints.positive;
        default = 8;
        description = "Memory per session, in GiB. Each session and the warm base reserve this plus 1 GiB of storage for saved memory.";
      };
      disk = mkOption {
        type = types.ints.positive;
        default = 50;
        description = "Root disk per session, in GiB.";
      };
      maxRunning = mkOption {
        type = types.ints.positive;
        default = 8;
        description = "Sessions that may run at once; suspended sessions do not count.";
      };
      maxMemory = mkOption {
        type = types.ints.positive;
        default = cfg.sessions.maxRunning * cfg.sessions.memory;
        defaultText = lib.literalExpression "config.services.bay.sessions.maxRunning * config.services.bay.sessions.memory";
        description = "Total running and starting session memory, in GiB, using each session's pinned machine allocation; suspended sessions do not count.";
      };
    };

    programs = mkOption {
      type = types.attrsOf programType;
      default = { };
      description = "Program definitions sessions start by name. A session started with a bare command launches it fresh on every start, with `monitor` on.";
    };

    machines = mkOption {
      type = types.attrsOf (
        types.submodule {
          options = {
            metadata = mkOption {
              type = types.path;
              description = "Incus image metadata tarball.";
            };
            disk = mkOption {
              type = types.path;
              description = "Incus guest disk image.";
            };
            resources = {
              cpus = mkOption {
                type = types.ints.positive;
                default = cfg.sessions.cpus;
                description = "vCPUs reserved for this machine's sessions.";
              };
              memory = mkOption {
                type = types.ints.positive;
                default = cfg.sessions.memory;
                description = "Memory per session, in GiB.";
              };
              disk = mkOption {
                type = types.ints.positive;
                default = cfg.sessions.disk;
                description = "Root disk per session, in GiB.";
              };
            };
          };
        }
      );
      default = { };
      description = ''
        Named session machines. Equal images and resource allocations share an immutable warm base.
        The default machine comes from guest.modules and the session resource defaults.
      '';
    };

    guest.modules = mkOption {
      type = types.listOf types.deferredModule;
      default = [ ];
      description = "NixOS modules added to the session image, such as the programs sessions run and their configuration.";
    };

    mirrorRefresh = mkOption {
      type = types.str;
      default = "1h";
      description = "How often the host's repo mirrors fetch from their remotes, as a Go duration.";
    };

    notifications = mkOption {
      type = types.nullOr (
        types.submodule {
          options = {
            url = mkOption {
              type = types.str;
              example = "https://ntfy.example.com";
              description = "Base URL of the ntfy server alerts publish to.";
            };
            topic = mkOption {
              type = types.str;
              default = "bay";
              description = "ntfy topic alerts publish to.";
            };
            tokenFile = mkOption {
              type = types.externalPath;
              description = "File holding the ntfy access token of a user that may publish to the topic.";
            };
          };
        }
      );
      default = null;
      description = "Where alerts go; without it they are only logged.";
    };
  };

  config = lib.mkIf cfg.enable {
    services.bay.machines.default = {
      metadata = lib.mkDefault image.metadata;
      disk = lib.mkDefault image.disk;
    };
    assertions = [
      {
        assertion = config.users.users ? ${cfg.operator};
        message = "services.bay.operator names ${cfg.operator}, who is not a user on this host.";
      }
      {
        # Incus installs each session's network filters when its NIC starts; a flush removes them until the
        # session restarts.
        assertion = !config.networking.nftables.flushRuleset;
        message = "Bay needs networking.nftables.flushRuleset = false, which keeps Incus's nftables tables across firewall reloads.";
      }
    ]
    ++ lib.mapAttrsToList (name: _: {
      assertion = builtins.match "[a-z]([a-z0-9-]{0,61}[a-z0-9])?" name != null;
      message = "services.bay.machines.${name} must have a lowercase DNS-label name.";
    }) cfg.machines
    ++ lib.mapAttrsToList (name: program: {
      assertion = builtins.hasAttr program.machine cfg.machines;
      message = "services.bay.programs.${name}.machine names undeclared machine ${program.machine}.";
    }) cfg.programs;

    boot.supportedFilesystems.zfs = true;
    networking.nftables.enable = true;
    # conntrack marks the VMs' DHCP requests invalid, and the NixOS firewall drops invalid packets ahead of its
    # per-interface rules; the bay-sessions table below filters the bridge
    networking.firewall.trustedInterfaces = [ bridge ];
    networking.nftables.tables.bay-sessions = {
      family = "inet";
      # sessions reach the host only for DHCP and for DNS at the bridge address
      content = ''
        chain input {
          type filter hook input priority filter - 1; policy accept;
          iifname "${bridge}" udp dport 67 accept
          iifname "${bridge}" ip daddr ${bridgeAddress} meta l4proto { tcp, udp } th dport 53 accept
          iifname "${bridge}" drop
        }
      '';
    };

    virtualisation.incus = {
      enable = true;
      # the project config uses keys from the current Incus release
      package = lib.mkDefault pkgs.incus;
      preseed = {
        storage_pools = [
          {
            name = pool;
            driver = "zfs";
            config = {
              # snapshots keep the memory they captured outside each session's state quota
              "volume.zfs.use_refquota" = "true";
              # rolling back to a snapshot discards the snapshots taken after it
              "volume.zfs.remove_snapshots" = "true";
              # the pool keeps each session's state quota free for its saved memory
              "volume.zfs.reserve_space" = "true";
            }
            // (
              if cfg.storage.dataset == null then
                { inherit (cfg.storage) size; }
              else
                { source = cfg.storage.dataset; }
            );
          }
        ];
        networks = [
          {
            name = bridge;
            type = "bridge";
            config = {
              "ipv4.address" = cfg.network.address;
              "ipv4.nat" = "true";
              "ipv6.address" = "none";
              "dns.mode" = "none";
              "dns.include_hosts" = "false";
            };
          }
        ];
        projects = [
          {
            name = project;
            config = {
              "features.images" = "true";
              "features.profiles" = "true";
              "features.storage.volumes" = "true";
              restricted = "true";
              "restricted.devices.disk" = "managed";
              "restricted.devices.nic" = "managed";
              "restricted.devices.gpu" = "block";
              "restricted.devices.pci" = "block";
              "restricted.devices.usb" = "block";
              "restricted.devices.proxy" = "block";
              "restricted.devices.unix-char" = "block";
              "restricted.devices.unix-block" = "block";
              "restricted.devices.unix-hotplug" = "block";
              "restricted.devices.infiniband" = "block";
              "restricted.networks.access" = bridge;
              "restricted.storage-pools.access" = pool;
              "restricted.snapshots" = "allow";
              "restricted.virtual-machines.nesting" = "block";
              # Incus counts boot.host_shutdown_action among the low-level options and checks profiles against
              # the container and VM lists alike; limits.containers keeps containers out of the project
              "restricted.containers.lowlevel" = "allow";
              "restricted.virtual-machines.lowlevel" = "allow";
              "limits.containers" = "0";
            };
          }
        ];
      };
    };

    users.users = {
      bay = {
        isSystemUser = true;
        group = "bay";
        extraGroups = [ "incus-admin" ];
      };
      bay-gateway = {
        isSystemUser = true;
        group = "bay-gateway";
      };
      # attaching to a session runs incus exec as the operator
      ${cfg.operator}.extraGroups = [ "incus-admin" ];
    };
    users.groups = {
      bay = { };
      bay-gateway = { };
    };

    environment.systemPackages = [ bay ];

    systemd.services.bay-platform = {
      description = "Bay's session network ACL and profile";
      wantedBy = [ "multi-user.target" ];
      after = [ "incus-preseed.service" ];
      requires = [ "incus-preseed.service" ];
      path = [
        config.virtualisation.incus.clientPackage
        pkgs.jq
      ];
      # preseed has no network ACLs and only merges profiles, so both are replaced whole here
      script = ''
        incus network acl show ${acl} >/dev/null 2>&1 || incus network acl create ${acl}
        incus network acl edit ${acl} < ${aclConfig}
        incus profile edit default --project ${project} < ${profileConfig}
        incus query '/1.0/profiles?project=${project}' | jq -r '.[] | split("/") | last | split("?") | first' |
          while read -r profile; do
            [ "$profile" = default ] || incus profile delete "$profile" --project ${project}
          done
      '';
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
    };

    systemd.services.bay-base = {
      description = "Bay's declared warm bases, booted once from their session images";
      wantedBy = [ "multi-user.target" ];
      after = [ "bay-platform.service" ];
      requires = [ "bay-platform.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = map (
          { name, machine }:
          lib.escapeShellArgs [
            "${bay}/bin/bay-server"
            "base"
            "-config"
            (toString serverConfig)
            "-machine"
            name
            "-metadata"
            (toString machine.metadata)
            "-disk"
            (toString machine.disk)
          ]
        ) (builtins.attrValues bases);
        User = "bay";
        Group = "bay";
        TimeoutStartSec = "30min";
      };
    };

    systemd.sockets = {
      bay-server-api = {
        description = "Bay server API";
        wantedBy = [ "sockets.target" ];
        socketConfig = {
          ListenStream = apiSocket;
          SocketUser = cfg.operator;
          SocketMode = "0600";
          FileDescriptorName = "api";
          Service = "bay-server.service";
        };
      };
      bay-server-identity = {
        description = "Bay server identity lookups for the gateway";
        wantedBy = [ "sockets.target" ];
        socketConfig = {
          ListenStream = identitySocket;
          SocketUser = "bay-gateway";
          SocketMode = "0600";
          FileDescriptorName = "identity";
          Service = "bay-server.service";
        };
      };
      bay-gateway-sessions = {
        description = "Bay gateway for sessions";
        wantedBy = [ "sockets.target" ];
        socketConfig = {
          # the host's context ID and sessionapi.Port
          ListenStream = "vsock:2:800";
          FileDescriptorName = "sessions";
          Service = "bay-gateway.service";
        };
      };
      bay-gateway-operator = {
        description = "Bay gateway messaging for the Bay server";
        wantedBy = [ "sockets.target" ];
        socketConfig = {
          ListenStream = gatewaySocket;
          SocketUser = "bay";
          SocketMode = "0600";
          FileDescriptorName = "operator";
          Service = "bay-gateway.service";
        };
      };
    };

    systemd.services.bay-server = {
      description = "Bay server";
      wantedBy = [ "multi-user.target" ];
      after = [ "incus.service" ];
      wants = [ "incus.service" ];
      path = [ pkgs.git ];
      serviceConfig = {
        ExecStart = "${bay}/bin/bay-server -config ${serverConfig}";
        Sockets = [
          "bay-server-api.socket"
          "bay-server-identity.socket"
        ];
        User = "bay";
        Group = "bay";
        StateDirectory = "bay";
        StateDirectoryMode = "0700";
        # on SIGTERM the server first finishes its operations, where a start and its rollback get 15 minutes each,
        # and their git children run until it exits
        TimeoutStopSec = "35min";
        KillMode = "mixed";
        Restart = "on-failure";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        LockPersonality = true;
        SystemCallArchitectures = "native";
      };
    };

    systemd.services.bay-gateway = {
      description = "Bay session gateway";
      wantedBy = [ "multi-user.target" ];
      after = [ "bay-server-identity.socket" ];
      serviceConfig = {
        ExecStart = "${bay}/bin/bay-gateway -config ${gatewayConfig}";
        Sockets = [
          "bay-gateway-sessions.socket"
          "bay-gateway-operator.socket"
        ];
        User = "bay-gateway";
        Group = "bay-gateway";
        StateDirectory = "bay-gateway";
        StateDirectoryMode = "0700";
        LoadCredential = lib.optional (
          cfg.notifications != null
        ) "ntfy-token:${cfg.notifications.tokenFile}";
        CapabilityBoundingSet = [ "" ];
        MemoryMax = "1G";
        Restart = "on-failure";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_VSOCK"
          "AF_INET"
          "AF_INET6"
        ];
        LockPersonality = true;
        SystemCallArchitectures = "native";
      };
    };
  };
}
