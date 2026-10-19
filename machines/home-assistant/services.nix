{
  inputs,
  lib,
  pkgs,
  ...
}:
let
  haPkgs = import inputs.nixpkgs { system = pkgs.stdenv.hostPlatform.system; };
  packages = import ../../packages/home-assistant { pkgs = haPkgs; };
  fanPython = pkgs.python3.withPackages (ps: [ ps.smbus2 ]);
  matterImage = builtins.fromJSON (builtins.readFile ../../packages/home-assistant/matter-image.json);
in
{
  assertions = [
    {
      assertion = lib.versionAtLeast matterImage.version "1.4.0";
      message = "HAOS Matter app 9.2.0 uses Matter.js 1.4.0 state; never use the old Python server.";
    }
  ];
  systemd.services.ha-mcp = {
    description = "Home Assistant admin MCP (native equivalent of the HAOS app)";
    wantedBy = [ "multi-user.target" ];
    wants = [ "home-assistant.service" ];
    after = [ "home-assistant.service" ];
    unitConfig.ConditionPathExists = "/var/lib/hass/.migration-ready";
    environment = {
      HOME = "/var/lib/ha-mcp";
      XDG_DATA_HOME = "/var/lib/ha-mcp";
      HOMEASSISTANT_URL = "http://127.0.0.1:8123";
      MCP_HOST = "0.0.0.0";
      MCP_PORT = "9583";
    };
    serviceConfig = {
      DynamicUser = true;
      StateDirectory = "ha-mcp";
      WorkingDirectory = "/var/lib/ha-mcp";
      EnvironmentFile = "/var/lib/private/home-assistant/ha-mcp.env";
      ExecStart = "${packages.mcp}/bin/ha-mcp-web";
      Restart = "on-failure";
      RestartSec = 10;
      UMask = "0077";
      # Upstream startup/access logs can print the credential-bearing path.
      # Systemd still records exit status; keep those paths out of journald.
      StandardOutput = "null";
      StandardError = "null";
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      NoNewPrivileges = true;
    };
  };
  networking.firewall.allowedTCPPorts = [
    9583
    1883
  ];
  systemd.services.argonone-v3 = {
    description = "Argon ONE V3 linear cooling (55–75 Celsius)";
    wantedBy = [ "multi-user.target" ];
    after = [ "systemd-modules-load.service" ];
    serviceConfig = {
      ExecStart = "${fanPython}/bin/python3 ${../../scripts/home-assistant/argonone.py}";
      Restart = "always";
      RestartSec = 5;
      RuntimeDirectory = "argonone";
      RuntimeDirectoryMode = "0755";
      DevicePolicy = "closed";
      DeviceAllow = [ "/dev/i2c-1 rw" ];
      ProtectSystem = "strict";
      ProtectHome = true;
      NoNewPrivileges = true;
      UMask = "0022";
    };
  };
  services.home-assistant.config.command_line = [
    {
      sensor = {
        name = "Argon One Addon Fan Speed";
        unique_id = "argon_one_addon_fan_speed";
        command = "cat /run/argonone/fan.json";
        value_template = "{{ value_json.speed }}";
        unit_of_measurement = "%";
        scan_interval = 30;
      };
    }
  ];
  services.mosquitto = {
    enable = true;
    persistence = true;
    listeners = [
      {
        address = "0.0.0.0";
        port = 1883;
        settings.allow_anonymous = false;
        # Provisioned privately for the imported HA identity and every external
        # client. No Supervisor authentication backend is assumed on NixOS.
        omitPasswordAuth = true;
        authPlugins = [
          {
            plugin = "${lib.getLib pkgs.mosquitto}/lib/mosquitto_password_file.so";
            options.password_file = "/run/credentials/mosquitto.service/passwords";
          }
        ];
        acl = [ "topic readwrite #" ];
      }
    ];
  };
  systemd.services.mosquitto.serviceConfig.LoadCredential = [
    "passwords:/var/lib/private/home-assistant/mosquitto-passwords"
  ];
  systemd.services.mosquitto.unitConfig.ConditionPathExists = "/var/lib/hass/.migration-ready";
  # The current HAOS app is already the Node Matter.js implementation. The
  # nixpkgs Python 8.1.2 module is not a compatible replacement for its state.
  virtualisation.oci-containers.backend = "podman";
  virtualisation.oci-containers.containers.matter-server = {
    image = "${matterImage.image}@${matterImage.digest}";
    user = "1000:1000";
    volumes = [ "/var/lib/matter-server:/data" ];
    extraOptions = [ "--network=host" ];
    environment = {
      STORAGE_PATH = "/data";
      PORT = "5580";
      LISTEN_ADDRESS = "127.0.0.1";
      PRIMARY_INTERFACE = "end0";
      LOG_LEVEL = "info";
      # HA 2026.10.2 bridges its native Bluetooth stack to this endpoint. This
      # avoids raw HCI privileges in the unprivileged Matter container.
      BLE_PROXY = "true";
    };
    environmentFiles = [ "/run/matter-server/time-sync.env" ];
  };
  systemd.services.podman-matter-server = {
    aliases = [ "matter-server.service" ];
    unitConfig.ConditionPathExists = "/var/lib/hass/.migration-ready";
    serviceConfig.RuntimeDirectory = "matter-server";
    preStart = lib.mkBefore ''
      # Preserve the add-on's time_sync=auto semantics at each start.
      if [ "$(${pkgs.systemd}/bin/timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" = yes ]; then
        echo ENABLE_TIME_SYNC=true > /run/matter-server/time-sync.env
      else
        echo ENABLE_TIME_SYNC=false > /run/matter-server/time-sync.env
      fi
    '';
  };
  boot.kernel.sysctl."net.ipv4.ping_group_range" = "0 2147483647";
  # IPv6 and multicast are needed for Matter/Thread; there is no USB ZHA stick
  # to assign. The existing coordinator remains socket://192.168.1.149:6638.
  services.tailscale = {
    enable = true;
    openFirewall = true;
    package = haPkgs.tailscale;
    disableTaildrop = true;
    useRoutingFeatures = "client";
    extraDaemonFlags = [ "--no-logs-no-support" ];
    extraSetFlags = [
      "--accept-dns=true"
      "--accept-routes=true"
    ];
  };
  systemd.services.tailscaled.unitConfig.ConditionPathExists = "/var/lib/hass/.migration-ready";
  systemd.services.tailscaled-set.unitConfig.ConditionPathExists = "/var/lib/hass/.migration-ready";
  services.glances = {
    enable = true;
    extraArgs = [
      "--webserver"
      "--bind"
      "127.0.0.1"
    ];
  };
  # Stopped Studio Code and Get HACS add-ons are intentionally omitted. Code
  # and dependencies are pinned in this flake; HACS stays available for
  # inventory, while installing/updating store-backed code requires a commit.
  systemd.tmpfiles.rules = [
    "d /var/lib/private/home-assistant 0700 root root -"
    "d /var/lib/hass 0700 hass hass -"
    "d /var/lib/hass/.ssh 0700 hass hass -"
    # Numeric ownership matches the pinned upstream unprivileged image user.
    "d /var/lib/matter-server 0700 1000 1000 -"
  ];
  # Native backup replacement: configured only after the operator supplies an
  # encrypted remote repository and credentials. It must never silently fall
  # back to an unencrypted local copy on the same NVMe disk.
  services.restic.backups.home-assistant = {
    initialize = false;
    repositoryFile = "/var/lib/private/home-assistant/restic-repository";
    passwordFile = "/var/lib/private/home-assistant/restic-password";
    environmentFile = "/var/lib/private/home-assistant/restic-environment";
    paths = [ "/var/lib/home-assistant-backup" ];
    timerConfig = {
      OnCalendar = "*-*-* 03:30:00";
      RandomizedDelaySec = "15m";
      Persistent = true;
    };
    backupPrepareCommand = "${pkgs.python3}/bin/python3 ${../../scripts/home-assistant/consistent-backup.py} --operator-enabled";
    pruneOpts = [
      "--keep-daily 7"
      "--keep-weekly 4"
      "--keep-monthly 6"
    ];
  };
  # The timer is inert until the owner explicitly provisions this marker after
  # a remote restore test. Building the configuration never creates it.
  systemd.services.restic-backups-home-assistant.unitConfig.ConditionPathExists =
    "/var/lib/private/home-assistant/.backup-enabled";
  systemd.services.restic-backups-home-assistant.path = [
    pkgs.rclone
    pkgs.systemd
  ];
  environment.etc."home-assistant/migration-readme".text = ''
    This host is not provisioned by building this configuration.
    See scripts/home-assistant/runbook.md in the configuration repository.
    Never start HA against an unreviewed inspection snapshot.
  '';
}
