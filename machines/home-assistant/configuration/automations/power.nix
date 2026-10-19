{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    call
    state
    announce
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      actions = [ (call "switch.turn_on" entities.switch.reaperPower { }) ];
      alias = "Power / Turn on reaper in the morning";
      conditions = [ (state entities.binary_sensor.reaperPing "off") ];
      triggers = [
        {
          at = "07:00:00";
          trigger = "time";
        }
      ];
    }
    {
      actions = [
        {
          choose = [
            {
              conditions = [
                {
                  condition = "not";
                  conditions = [ (state entities.switch.reaperPower [ "on" ]) ];
                }
              ];
              sequence = [
                (call "button.press" entities.button.reaperWake { })
                {
                  delay = {
                    minutes = 2;
                  };
                }
              ];
            }
          ];
        }
        { action = "shell_command.reaper_windows"; }
      ];
      alias = "Power / Reaper Windows Button";
      triggers = [
        {
          entity_id = [ entities.input_button.reaperWindows ];
          trigger = "state";
        }
      ];
    }
    {
      actions = [
        {
          variables = {
            message = templates.city_power_off;
          };
        }
        (announce templates.message { preannounce = true; })
        {
          action = "telegram_bot.send_message";
          data = {
            disable_notification = true;
            inherit (templates) message;
          };
        }
      ];
      alias = "Power / City power is off";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.cityPower ];
          for = {
            seconds = 5;
          };
          from = [ "on" ];
          to = [ "off" ];
          trigger = "state";
        }
      ];
    }
    {
      actions = [
        (announce templates.battery_low { preannounce = true; })
      ];
      alias = "Power / Low battery";
      triggers =
        map
          (below: {
            inherit below;
            entity_id = [ entities.sensor.batteryCharge ];
            for.seconds = 10;
            trigger = "numeric_state";
          })
          [
            31
            21
            11
            6
          ];
    }
    {
      actions = [
        (announce templates.battery_time_low { preannounce = true; })
      ];
      alias = "Power / Low battery remaining time";
      triggers = [
        {
          below = 1;
          entity_id = [ entities.sensor.batteryRemainingTime ];
          for = {
            seconds = 5;
          };
          trigger = "numeric_state";
        }
      ];
    }
    {
      actions = [ (announce "Hoard is offline" { }) ];
      alias = "Power / Hoard is offline";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.hoard ];
          from = [ "on" ];
          trigger = "state";
        }
      ];
    }
    {
      actions = [ (announce "Hoard is back online." { }) ];
      alias = "Power / Hoard is back online";
      conditions = [ (state entities.input_boolean.fullyLoaded "on") ];
      triggers = [
        {
          trigger = "state";
          entity_id = entities.binary_sensor.hoard;
          to = "on";
        }
      ];
    }
    {
      actions = [
        {
          variables = {
            message = templates.city_power_on;
          };
        }
        (announce templates.message { preannounce = true; })
        {
          action = "telegram_bot.send_message";
          data = {
            disable_notification = true;
            inherit (templates) message;
          };
        }
      ];
      alias = "Power / City power back on";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.cityPower ];
          from = [ "off" ];
          to = [ "on" ];
          trigger = "state";
        }
      ];
    }
  ];
}
