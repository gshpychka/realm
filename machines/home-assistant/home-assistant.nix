{
  config,
  haPackages,
  lib,
  pkgs,
  ...
}:
{
  imports = [ ./configuration ];

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
    preStart = lib.mkMerge [
      (lib.mkBefore ''
        # Check restored files before the native module overwrites configuration
        # or tries to install links into an existing component/app directory.
        config_dir=${lib.escapeShellArg config.services.home-assistant.configDir}
        migration_conflict() {
          echo "Home Assistant: preserve and move $1 before starting the declarative service; see machines/home-assistant/migration.md." >&2
          exit 1
        }
        for managed_path in "$config_dir/configuration.yaml" "$config_dir/secrets.yaml" "$config_dir/pyscript/apps/yasno_address_guard"; do
          if [ -e "$managed_path" ] && [ ! -L "$managed_path" ]; then
            migration_conflict "$managed_path"
          fi
        done
        if [ -L "$config_dir/custom_components" ]; then
          migration_conflict "$config_dir/custom_components"
        fi
        for component in "$config_dir"/custom_components/*; do
          if [ "''${component##*/}" = __pycache__ ]; then
            continue
          fi
          if [ -L "$component" ]; then
            case "$(readlink "$component")" in
              /nix/store/*) ;;
              *) migration_conflict "$component" ;;
            esac
          elif [ -e "$component" ]; then
            migration_conflict "$component"
          fi
        done
        # Declarative migration guard ends here.
      '')
      (lib.mkAfter ''
        ln -sfnT "$CREDENTIALS_DIRECTORY/secrets.yaml" /var/lib/hass/secrets.yaml
        mkdir -p /var/lib/hass/pyscript/apps /var/lib/hass/yasno-address-guard /var/lib/hass/media
        # The app source is immutable; its transaction/recovery journal is state.
        ln -sfnT ${./runtime/yasno-address-guard} /var/lib/hass/pyscript/apps/yasno_address_guard
      '')
    ];
  };
}
