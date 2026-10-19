{ haDevices, ... }:
{

  game_mode = {
    alias = "Game mode";
    sequence = [
      {
        parallel = [
          {
            "if" = [
              {
                condition = "device";
                device_id = haDevices.tv;
                domain = "media_player";
                entity_id = "7dd4bf5f56627ca44da4c7f5250ada00";
                type = "is_off";
              }
            ];
            "then" = [
              {
                action = "media_player.turn_on";
                data = { };
                target = {
                  device_id = haDevices.tv;
                };
                continue_on_error = true;
              }
              {
                action = "media_player.turn_on";
                target = {
                  entity_id = "media_player.tv_qe65s95cauxua";
                };
                data = { };
                continue_on_error = true;
              }
            ];
          }
          {
            action = "switch.turn_on";
            data = { };
            target = {
              device_id = "e3155405d8b7e8259c71146a6f111324";
            };
          }
        ];
      }
      {
        delay = {
          hours = 0;
          minutes = 0;
          seconds = 30;
          milliseconds = 0;
        };
      }
      {
        sequence = [
          {
            action = "media_player.select_source";
            data = {
              source = "PC";
            };
            target = {
              device_id = haDevices.tv;
            };
            enabled = false;
            continue_on_error = true;
          }
          {
            action = "shell_command.reaper_windows";
            data = { };
          }
        ];
      }
    ];
    description = "Enable/enter/initiate game mode.";
    icon = "mdi:controller";
  };
  toggle_vinyl = {
    alias = "Toggle vinyl";
    sequence = [
      {
        action = "media_player.turn_on";
        data = { };
        target = {
          entity_id = "media_player.soundbar";
        };
      }
      {
        delay = {
          hours = 0;
          minutes = 0;
          seconds = 5;
          milliseconds = 0;
        };
      }
      {
        "if" = [
          {
            condition = "state";
            entity_id = "media_player.soundbar";
            state = "digital";
            attribute = "source";
          }
        ];
        "then" = [
          {
            action = "media_player.select_source";
            data = {
              source = "wifi";
            };
            target = {
              entity_id = "media_player.soundbar";
            };
          }
        ];
        "else" = [
          {
            action = "media_player.select_source";
            data = {
              source = "digital";
            };
            target = {
              entity_id = [
                "media_player.soundbar"
              ];
            };
          }
        ];
      }
    ];
    icon = "mdi:album";
  };

}
