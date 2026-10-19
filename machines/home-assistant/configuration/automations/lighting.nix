{ haDevices, ... }:
{
  services.home-assistant.config.automation = [
    {
      id = "1735822501432";
      alias = "Lighting / Overhead lights toggle";
      triggers = [
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_short_press";
          subtype = "remote_button_short_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_triple_press";
          subtype = "remote_button_triple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedShelfButton;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "button_1";
          trigger = "device";
        }
        {
          device_id = haDevices.kitchenLightswitch;
          domain = "zha";
          type = "remote_button_quadruple_press";
          subtype = "remote_button_quadruple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_short_press";
          subtype = "remote_button_short_press";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "light.toggle";
          data = { };
          target = {
            entity_id = "light.room_overhead_lights";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1735822817931";
      alias = "Lighting / Kitchen lights toggle";
      triggers = [
        {
          device_id = haDevices.kitchenLightswitch;
          domain = "zha";
          type = "remote_button_short_press";
          subtype = "remote_button_short_press";
          trigger = "device";
        }
        {
          device_id = haDevices.kitchenTableButton;
          domain = "zha";
          type = "remote_button_short_press";
          subtype = "remote_button_short_press";
          trigger = "device";
        }
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_quadruple_press";
          subtype = "remote_button_quadruple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_quadruple_press";
          subtype = "remote_button_quadruple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_quadruple_press";
          subtype = "remote_button_quadruple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedShelfButton;
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
          enabled = false;
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "light.toggle";
          data = { };
          target = {
            entity_id = "light.kitchen_lights";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1735822879704";
      alias = "Lighting / Bed light toggle";
      triggers = [
        {
          alias = "Bed button single";
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_short_press";
          subtype = "remote_button_short_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedShelfButton;
          domain = "zha";
          type = "remote_button_short_press";
          subtype = "button_1";
          trigger = "device";
          alias = "Bed shelf button single";
        }
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_triple_press";
          subtype = "remote_button_triple_press";
          trigger = "device";
          alias = "Room lightswitch triple";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_triple_press";
          subtype = "remote_button_triple_press";
          trigger = "device";
          alias = "Room table button triple";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "light.toggle";
          data = { };
          target = {
            device_id = "03b9cc7e343604396bb64815efa78500";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1736777638584";
      alias = "Lighting / Party light toggle";
      triggers = [
        {
          device_id = haDevices.kitchenLightswitch;
          domain = "zha";
          type = "remote_button_triple_press";
          subtype = "remote_button_triple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.kitchenTableButton;
          domain = "zha";
          type = "remote_button_triple_press";
          subtype = "remote_button_triple_press";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "light.toggle";
          data = { };
          target = {
            device_id = "60e41fc3a2858a76ce0ffb1f67f9957d";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1736777817476";
      alias = "Lighting / Room lights full brightness";
      triggers = [
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "remote_button_double_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "remote_button_double_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedShelfButton;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "button_1";
          trigger = "device";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "remote_button_double_press";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "light.turn_on";
          data = {
            brightness_pct = 100;
            transition = 1;
          };
          target = {
            entity_id = "light.room_overhead_lights";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1736777871135";
      alias = "Lighting / Kitchen lights full brightness";
      triggers = [
        {
          device_id = haDevices.kitchenLightswitch;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "remote_button_double_press";
          trigger = "device";
        }
        {
          device_id = haDevices.kitchenTableButton;
          domain = "zha";
          type = "remote_button_double_press";
          subtype = "remote_button_double_press";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "light.turn_on";
          data = {
            brightness_pct = 100;
            transition = 1;
          };
          target = {
            entity_id = "light.kitchen_lights";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1749390846354";
      alias = "Lighting / Cute lights toggle";
      triggers = [
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
          alias = "Room switch long-press";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
          alias = "Room table button long-press";
        }
        {
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
          alias = "Bed button long-press";
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "timer.movie_scene_offer_window";
          state = "idle";
          note = "While the movie scene offer window runs, a long press belongs to the movie scene instead.";
        }
      ];
      actions = [
        {
          action = "light.toggle";
          data = { };
          target = {
            entity_id = "light.cute_lights";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1749471372840";
      alias = "Lighting / Turn on plant light";
      triggers = [
        {
          trigger = "time";
          at = "08:00:00";
          id = "morning";
          alias = "8:00 AM";
        }
        {
          alias = "Cloud coverage is above 40";
          trigger = "numeric_state";
          entity_id = [
            "weather.openweathermap"
          ];
          attribute = "cloud_coverage";
          above = 40;
          id = "cloudy";
          for = {
            hours = 0;
            minutes = 1;
            seconds = 0;
          };
          enabled = false;
        }
      ];
      conditions = [
        {
          condition = "and";
          conditions = [
            {
              condition = "time";
              after = "08:00:00";
              before = "20:00:00";
              alias = "During the day";
              enabled = false;
            }
            {
              alias = "Cloudy and summer or morning and not summer";
              condition = "or";
              conditions = [
                {
                  alias = "Cloudy and summer";
                  condition = "and";
                  conditions = [
                    {
                      condition = "trigger";
                      id = [
                        "cloudy"
                      ];
                      enabled = false;
                    }
                    {
                      condition = "template";
                      value_template = "{{ now().month in [6, 7, 8] }}";
                      alias = "Summer";
                    }
                    {
                      condition = "numeric_state";
                      entity_id = "weather.openweathermap";
                      attribute = "cloud_coverage";
                      above = 40;
                      alias = "Cloudy";
                    }
                  ];
                }
                {
                  alias = "Morning and not summer";
                  condition = "and";
                  conditions = [
                    {
                      condition = "trigger";
                      id = [
                        "morning"
                      ];
                    }
                    {
                      condition = "template";
                      value_template = "{{ now().month not in [6, 7, 8] }}";
                      alias = "Not summer";
                    }
                  ];
                }
              ];
              enabled = false;
            }
            {
              condition = "light.is_off";
              target = {
                entity_id = "light.plant_light";
              };
              options = { };
              enabled = true;
            }
          ];
          enabled = true;
        }
      ];
      actions = [
        {
          alias = "Turn on Plant light";
          action = "light.turn_on";
          data = { };
          target = {
            entity_id = "light.plant_light";
          };
        }
        {
          "if" = [
            {
              condition = "trigger";
              id = [
                "cloudy"
              ];
            }
          ];
          "then" = [
            {
              action = "assist_satellite.announce";
              data = {
                message = "The plant light has been turned on because it's cloudy";
                preannounce = true;
              };
              target = {
                area_id = "room";
              };
            }
          ];
          enabled = false;
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1749471809764";
      alias = "Lighting / Turn off plant light";
      triggers = [
        {
          alias = "8:00 PM";
          trigger = "time";
          at = "20:00:00";
          id = "evening";
        }
        {
          alias = "Cloud coverage is below 40";
          trigger = "numeric_state";
          entity_id = [
            "weather.openweathermap"
          ];
          attribute = "cloud_coverage";
          id = "not_cloudy";
          below = 40;
          enabled = false;
        }
      ];
      conditions = [
        {
          condition = "and";
          conditions = [
            {
              alias = "During the day";
              condition = "time";
              after = "08:00:00";
              before = "20:01:00";
              enabled = false;
            }
            {
              alias = "Not cloudy and summer or evening";
              condition = "or";
              conditions = [
                {
                  alias = "Not cloudy and summer";
                  condition = "and";
                  conditions = [
                    {
                      condition = "trigger";
                      id = [
                        "not_cloudy"
                      ];
                    }
                    {
                      condition = "template";
                      value_template = "{{ now().month in [6, 7, 8] }}";
                      alias = "Summer";
                    }
                  ];
                }
                {
                  condition = "trigger";
                  id = [
                    "evening"
                  ];
                }
              ];
              enabled = false;
            }
            {
              condition = "light.is_on";
              target = {
                entity_id = "light.plant_light";
              };
              options = { };
            }
          ];
        }
      ];
      actions = [
        {
          action = "light.turn_off";
          data = { };
          target = {
            entity_id = "light.plant_light";
          };
        }
        {
          "if" = [
            {
              condition = "trigger";
              id = [
                "not_cloudy"
              ];
            }
          ];
          "then" = [
            {
              action = "assist_satellite.announce";
              data = {
                message = "The plant light has been turned off because it's no longer cloudy.";
                preannounce = true;
              };
              target = {
                area_id = "room";
              };
            }
          ];
          enabled = false;
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1755457211035";
      alias = "Lighting / Lava lamp toggle";
      triggers = [
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
          alias = "Room switch long-press";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
          alias = "Room table button long-press";
        }
        {
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
          alias = "Bed button long-press";
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "timer.movie_scene_offer_window";
          state = "idle";
          note = "While the movie scene offer window runs, a long press belongs to the movie scene instead.";
        }
      ];
      actions = [
        {
          action = "light.toggle";
          data = { };
          target = {
            entity_id = "light.lava_lamp";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1765384948992";
      alias = "Lighting / Flash light when Room assistant starts listening";
      triggers = [
        {
          trigger = "assist_satellite.listening";
          target = {
            area_id = "room";
          };
          options = {
            behavior = "each";
          };
        }
      ];
      conditions = [
        {
          condition = "light.is_on";
          target = {
            entity_id = "light.room_overhead_lights";
          };
          options = {
            behavior = "any";
          };
        }
      ];
      actions = [
        {
          device_id = haDevices.overhead4;
          domain = "light";
          entity_id = "f939ae4e06e28afa4afedb6b3a17a683";
          type = "brightness_decrease";
          enabled = true;
        }
        {
          device_id = haDevices.overhead4;
          domain = "light";
          entity_id = "f939ae4e06e28afa4afedb6b3a17a683";
          type = "brightness_increase";
        }
        {
          device_id = haDevices.overhead4;
          domain = "light";
          entity_id = "f939ae4e06e28afa4afedb6b3a17a683";
          type = "brightness_decrease";
          enabled = true;
        }
        {
          device_id = haDevices.overhead4;
          domain = "light";
          entity_id = "f939ae4e06e28afa4afedb6b3a17a683";
          type = "brightness_increase";
        }
      ];
      mode = "single";
      initial_state = true;
    }
  ];
}
