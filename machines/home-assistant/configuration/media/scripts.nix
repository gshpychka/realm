{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    state
    ;
in
{
  services.home-assistant.config.script = builtins.mapAttrs (_: ha.script) {
    game_mode = {
      alias = "Game mode";
      description = "Enable/enter/initiate game mode.";
      icon = "mdi:controller";
      sequence = [
        {
          parallel = [
            {
              "if" = [ (state entities.media_player.tv "off") ];
              "then" = [
                {
                  action = "media_player.turn_on";
                  continue_on_error = true;
                  target = {
                    entity_id = entities.media_player.tv;
                  };
                }
                {
                  action = "media_player.turn_on";
                  continue_on_error = true;
                  target = {
                    entity_id = entities.media_player.tvQe65S95Cauxua;
                  };
                }
              ];
            }
            {
              action = "switch.turn_on";
              target = {
                device_id = devices.reaperWakeTarget;
              };
            }
          ];
        }
        {
          delay = {
            seconds = 30;
          };
        }
        { sequence = [ { action = "shell_command.reaper_windows"; } ]; }
      ];
    };
  };
}
