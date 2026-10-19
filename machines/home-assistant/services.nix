{
  ha,
  haPackages,
  haPkgs,
  lib,
  pkgs,
  ...
}:
let
  inherit (ha) templates;
  fanPython = pkgs.python3.withPackages (ps: [ ps.smbus2 ]);
  matterImage = import ../../packages/home-assistant/matter-image.nix;
in
{
  systemd.services.ha-mcp = {
    description = "Home Assistant admin MCP";
    wantedBy = [ "multi-user.target" ];
    wants = [ "home-assistant.service" ];
    after = [ "home-assistant.service" ];
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
      ExecStart = "${haPackages.mcp}/bin/ha-mcp-web";
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
      ExecStart = "${fanPython}/bin/python3 ${./argonone.py}";
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
        name = "Argon ONE Fan Speed";
        unique_id = "argon_one_fan_speed";
        command = "cat /run/argonone/fan-status";
        value_template = templates.fan_speed;
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
        # Password hashes for HA and external clients are runtime credentials.
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
  # Matter.js provides the HA WebSocket endpoint and owns its writable /data.
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
    serviceConfig.RuntimeDirectory = "matter-server";
    preStart = lib.mkBefore ''
      # Enable time synchronization only when the host clock is synchronized.
      if [ "$(${pkgs.systemd}/bin/timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" = yes ]; then
        echo ENABLE_TIME_SYNC=true > /run/matter-server/time-sync.env
      else
        echo ENABLE_TIME_SYNC=false > /run/matter-server/time-sync.env
      fi
    '';
  };
  boot.kernel.sysctl."net.ipv4.ping_group_range" = "0 2147483647";
  # Matter/Thread use IPv6 multicast; ZHA uses a network coordinator.
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
  services.glances = {
    enable = true;
    extraArgs = [
      "--webserver"
      "--bind"
      "127.0.0.1"
    ];
  };
  systemd.tmpfiles.rules = [
    "d /var/lib/private/home-assistant 0700 root root -"
    "d /var/lib/hass 0700 hass hass -"
    "d /var/lib/hass/.ssh 0700 hass hass -"
    # Numeric ownership matches the pinned upstream unprivileged image user.
    "d /var/lib/matter-server 0700 1000 1000 -"
  ];
  # Encrypted remote backups use privately provisioned repository credentials.
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
    backupPrepareCommand = "${pkgs.python3}/bin/python3 ${./consistent-backup.py}";
    pruneOpts = [
      "--keep-daily 7"
      "--keep-weekly 4"
      "--keep-monthly 6"
    ];
  };
  systemd.services.restic-backups-home-assistant.path = [
    pkgs.rclone
    pkgs.systemd
  ];
}
