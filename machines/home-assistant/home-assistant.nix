{
  config,
  haPackages,
  inputs,
  lib,
  pkgs,
  ...
}:
{
  imports = [ ./configuration ];

  # The offline x86 config/schema/behavior check is a required build dependency,
  # including when the Pi closure is built separately from flake checks.
  system.extraDependencies = [
    (import ../../packages/home-assistant/tests {
      pkgs = inputs.nixpkgs.legacyPackages.x86_64-linux;
      configuration = config.services.home-assistant.config;
      inherit (config.services.home-assistant) extraComponents;
    })
  ];

  services.home-assistant = {
    enable = true;
    package = haPackages.core;
    configDir = "/var/lib/hass";
    extraComponents = [
      "analytics"
      "androidtv_remote"
      "apple_tv"
      "asuswrt"
      "backup"
      "bluetooth"
      "cast"
      "cloud"
      "command_line"
      "conversation"
      "default_config"
      "device_automation"
      "dlna_dmr"
      "elevenlabs"
      "esphome"
      "ffmpeg"
      "filter"
      "frontend"
      "glances"
      "go2rtc"
      "google"
      "google_generative_ai_conversation"
      "homekit"
      "http"
      "hue"
      "kodi"
      "lametric"
      "lovelace"
      "matter"
      "mcp_server"
      "min_max"
      "mobile_app"
      "mqtt"
      "network"
      "ollama"
      "openai_conversation"
      "openweathermap"
      "overseerr"
      "persistent_notification"
      "ping"
      "playstation_network"
      "plex"
      "radarr"
      "repairs"
      "rest"
      "rest_command"
      "rpi_power"
      "sabnzbd"
      "samsungtv"
      "shell_command"
      "shopping_list"
      "smartthings"
      "smlight"
      "sonarr"
      "sun"
      "switch_as_x"
      "systemmonitor"
      "tautulli"
      "telegram_bot"
      "template"
      "thread"
      "time_date"
      "ukraine_alarm"
      "upnp"
      "wake_on_lan"
      "websocket_api"
      "wyoming"
      "xbox"
      "xiaomi_ble"
      "zeroconf"
      "zha"
    ];
    inherit (haPackages) customComponents;
    openFirewallForComponents = true;
  };
  systemd.services.home-assistant = {
    wants = [
      "mosquitto.service"
      "matter-server.service"
    ];
    after = [
      "mosquitto.service"
      "matter-server.service"
    ];
    serviceConfig = {
      LoadCredential = [ "secrets.yaml:/var/lib/private/home-assistant/secrets.yaml" ];
      MemoryHigh = "2500M";
      MemoryMax = "3G";
    };
    path = [ pkgs.openssh ];
    preStart = lib.mkAfter ''
      ln -sfn "$CREDENTIALS_DIRECTORY/secrets.yaml" /var/lib/hass/secrets.yaml
      mkdir -p /var/lib/hass/pyscript/apps /var/lib/hass/yasno-address-guard /var/lib/hass/media
      # The app source is immutable; its transaction/recovery journal is state.
      ln -sfn ${./runtime/yasno-address-guard} /var/lib/hass/pyscript/apps/yasno_address_guard
      # HA registers /local/ only if www/ exists at startup; nixpkgs' Core patch
      # lets it follow this store symlink. Other www/ entries are left alone.
      # The dashboard and its versioned module resource are HA-owned storage.
      mkdir -p /var/lib/hass/www
      ln -sfn ${./runtime/victron-live} /var/lib/hass/www/victron-live
    '';
  };
}
