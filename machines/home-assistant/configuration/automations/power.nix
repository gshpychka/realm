{
  services.home-assistant.config.automation = [
    {
      id = "1740518034489";
      alias = "Power / Turn off reaper at night";
      triggers = [
        {
          trigger = "time";
          at = "01:00:00";
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "switch.reaper_power";
          state = "on";
        }
      ];
      actions = [
        {
          action = "switch.turn_off";
          data = { };
          target = {
            entity_id = "switch.reaper_power";
          };
        }
      ];
      mode = "single";
      initial_state = false;
    }
    {
      id = "1740518221778";
      alias = "Power / Turn on reaper in the morning";
      triggers = [
        {
          trigger = "time";
          at = "07:00:00";
        }
      ];
      conditions = [
        {
          type = "is_not_connected";
          condition = "device";
          device_id = "e04d63f6fbae46315b2dc79884dfd295";
          entity_id = "f1e889e5f114f39897a0a0d1e7913359";
          domain = "binary_sensor";
        }
      ];
      actions = [
        {
          action = "switch.turn_on";
          data = { };
          target = {
            entity_id = "switch.reaper_power";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1752228037308";
      alias = "Power / Reaper Windows Button";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "input_button.reaper_windows"
          ];
        }
      ];
      conditions = [ ];
      actions = [
        {
          choose = [
            {
              conditions = [
                {
                  condition = "not";
                  conditions = [
                    {
                      condition = "state";
                      entity_id = "switch.reaper_power";
                      state = [
                        "on"
                      ];
                    }
                  ];
                }
              ];
              sequence = [
                {
                  device_id = "e3155405d8b7e8259c71146a6f111324";
                  domain = "button";
                  entity_id = "67ee0a3e139417c8c64a0c89ed2cb6d8";
                  type = "press";
                }
                {
                  delay = {
                    hours = 0;
                    minutes = 2;
                    seconds = 0;
                    milliseconds = 0;
                  };
                }
              ];
            }
          ];
        }
        {
          action = "shell_command.reaper_windows";
          data = { };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1761754817178";
      alias = "Power / City power is off";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.city_power"
          ];
          from = [
            "on"
          ];
          to = [
            "off"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 5;
          };
        }
      ];
      conditions = [ ];
      actions = [
        {
          variables = {
            message = "City power is off. {% set schedule = states('sensor.yasno_power') %} {% if schedule == 'outage' %} This is a scheduled outage. {% set restoration = as_datetime(states('sensor.yasno_next_power'), none) %} {% set remaining = (as_timestamp(restoration) - as_timestamp(now())) if restoration is not none else none %} {% if remaining is not none and remaining > 0 %} {% if remaining < 3600 %} Power should be back on in less than an hour. {% else %} {% set hours = (remaining / 3600) | round(0) | int %} Power should be back on in about {{ hours }} {{ 'hour' if hours == 1 else 'hours' }}. {% endif %} {% else %} No information about how long the outage will last. {% endif %} {% elif schedule == 'normal' %} This is not a scheduled outage. {% else %} The outage schedule is unavailable, so I cannot confirm whether this outage is scheduled. {% endif %} Battery is at {{states('sensor.battery_charge') | int('unknown') }} percent. Current power draw is {{ states('sensor.multiplus_output_power_l1') }} Watts.";
          };
        }
        {
          action = "assist_satellite.announce";
          data = {
            preannounce = true;
            message = "{{ message }}";
          };
          target = {
            area_id = "room";
          };
          enabled = true;
        }
        {
          action = "telegram_bot.send_message";
          data = {
            message = "{{ message }}";
            disable_notification = true;
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1763747070957";
      alias = "Power / Low battery";
      triggers = [
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.battery_charge"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          below = 31;
        }
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.battery_charge"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          below = 21;
        }
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.battery_charge"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          below = 11;
        }
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.battery_charge"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          below = 6;
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Warning: The battery level is - {{states('sensor.battery_charge') | int }}  percent...";
            preannounce = true;
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1765823486412";
      alias = "Power / Low battery remaining time";
      triggers = [
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.battery_remaining_time"
          ];
          below = 1;
          for = {
            hours = 0;
            minutes = 0;
            seconds = 5;
          };
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Warning: Less than one hour of battery power remaining. Battery is at {{ states('sensor.battery_charge') | round(0) }} percent.";
            preannounce = true;
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1766322149528";
      alias = "Power / Hoard is offline";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.hoard"
          ];
          from = [
            "on"
          ];
          to = null;
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Hoard is offline";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1766322208678";
      alias = "Power / Hoard is back online";
      triggers = [
        {
          type = "connected";
          device_id = "94d1c5cb4856ce1e9595d5f30ff134ab";
          entity_id = "3019a09497b3880fdd84c12f2488536a";
          domain = "binary_sensor";
          trigger = "device";
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "input_boolean.homeassistant_fully_loaded";
          state = "on";
        }
      ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Hoard is back online.";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1768472043250";
      alias = "Power / City power back on";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.city_power"
          ];
          from = [
            "off"
          ];
          to = [
            "on"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 0;
          };
        }
      ];
      conditions = [ ];
      actions = [
        {
          variables = {
            message = "Power is back on. Battery is at {{states('sensor.battery_charge') | int('unknown') }} percent.";
          };
        }
        {
          action = "assist_satellite.announce";
          data = {
            preannounce = true;
            message = "{{ message }}";
          };
          target = {
            area_id = "room";
          };
          enabled = true;
        }
        {
          action = "telegram_bot.send_message";
          data = {
            message = "{{ message }}";
            disable_notification = true;
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
  ];
}
