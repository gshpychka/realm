{ ha, ... }:
{
  services.home-assistant.config = {
    homeassistant.media_dirs.local = "/var/lib/hass/media";
    default_config = { };
    media_player = [
      {
        platform = "smartthings_soundbar";
        name = "Soundbar";
        api_key = "!secret soundbar_api_key";
        device_id = ha.devices.soundbarCloud;
        max_volume = 30;
      }
    ];
    shell_command = {
      reaper_windows = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/hass/.ssh/known_hosts -o IdentitiesOnly=yes -i /var/lib/hass/.ssh/outbound_key hass@reaper.glib.sh \"sudo bootctl set-oneshot auto-windows && sudo reboot\"";
      turn_off_reaper = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/hass/.ssh/known_hosts -o IdentitiesOnly=yes -i /var/lib/hass/.ssh/outbound_key hass@reaper.glib.sh \"sudo shutdown -h now\"";
    };
    binary_sensor = [
      {
        platform = "rest";
        name = "Ollama status";
        unique_id = "ollama_status";
        device_class = "connectivity";
        value_template = "{{ 'qwen3.5:9b-q8_0' in value_json.models | map(attribute='name') | list }}";
        resource = "https://reaper.glib.sh/ollama/api/tags";
      }
    ];
    rest_command = {
      ollama_preload = {
        url = "https://reaper.glib.sh/ollama/api/generate";
        method = "POST";
        content_type = "application/json; charset=utf-8";
        timeout = "60";
        payload = builtins.toJSON {
          model = "qwen3.5:9b-q8_0";
          keep_alive = -1;
        };
      };
    };
    pyscript = {
      apps = {
        yasno_address_guard = "!secret yasno_address_guard";
      };
    };
    frontend = { };
  };
}
