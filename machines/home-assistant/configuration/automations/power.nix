{ ha, ... }:
let
  inherit (ha)
    entities
    automation
    call
    state
    announce
    ;
in
{
  services.home-assistant.config.automation = [
    (automation "power_turn_on_reaper_in_the_morning" {
      actions = [ (call "switch.turn_on" entities.switch.reaperPower { }) ];
      alias = "Power / Turn on reaper in the morning";
      conditions = [ (state entities.binary_sensor.reaperPing "off") ];
      triggers = [
        {
          at = "07:00:00";
          trigger = "time";
        }
      ];
    })
    (automation "power_reaper_windows_button" {
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
    })
    (automation "power_city_power_is_off" {
      actions = [
        {
          variables = {
            message = "City power is off. {% set schedule = states('${entities.sensor.yasnoPower}') %} {% if schedule == 'outage' %} This is a scheduled outage. {% set restoration = as_datetime(states('${entities.sensor.yasnoNextPower}'), none) %} {% set remaining = (as_timestamp(restoration) - as_timestamp(now())) if restoration is not none else none %} {% if remaining is not none and remaining > 0 %} {% if remaining < 3600 %} Power should be back on in less than an hour. {% else %} {% set hours = (remaining / 3600) | round(0) | int %} Power should be back on in about {{ hours }} {{ 'hour' if hours == 1 else 'hours' }}. {% endif %} {% else %} No information about how long the outage will last. {% endif %} {% elif schedule == 'normal' %} This is not a scheduled outage. {% else %} The outage schedule is unavailable, so I cannot confirm whether this outage is scheduled. {% endif %} Battery is at {{states('${entities.sensor.batteryCharge}') | int('unknown') }} percent. Current power draw is {{ states('${entities.sensor.multiplusOutputPowerL1}') }} Watts.";
          };
        }
        (announce "{{ message }}" { preannounce = true; })
        {
          action = "telegram_bot.send_message";
          data = {
            disable_notification = true;
            message = "{{ message }}";
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
    })
    (automation "power_low_battery" {
      actions = [
        (announce
          "Warning: The battery level is - {{states('${entities.sensor.batteryCharge}') | int }}  percent..."
          { preannounce = true; }
        )
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
    })
    (automation "power_low_battery_remaining_time" {
      actions = [
        (announce
          "Warning: Less than one hour of battery power remaining. Battery is at {{ states('${entities.sensor.batteryCharge}') | round(0) }} percent."
          { preannounce = true; }
        )
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
    })
    (automation "power_hoard_is_offline" {
      actions = [ (announce "Hoard is offline" { }) ];
      alias = "Power / Hoard is offline";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.hoard ];
          from = [ "on" ];
          trigger = "state";
        }
      ];
    })
    (automation "power_hoard_is_back_online" {
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
    })
    (automation "power_city_power_back_on" {
      actions = [
        {
          variables = {
            message = "Power is back on. Battery is at {{states('${entities.sensor.batteryCharge}') | int('unknown') }} percent.";
          };
        }
        (announce "{{ message }}" { preannounce = true; })
        {
          action = "telegram_bot.send_message";
          data = {
            disable_notification = true;
            message = "{{ message }}";
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
    })
  ];
}
