{ ha, ... }:
let
  inherit (ha)
    quintuplePress
    devices
    templates
    entities
    call
    state
    announce
    ;
  notifyPowerChange = message: [
    { variables = { inherit message; }; }
    (announce templates.message { preannounce = true; })
    {
      action = "telegram_bot.send_message";
      data = {
        disable_notification = true;
        inherit (templates) message;
      };
    }
  ];
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      id = "1740518221778";
      alias = "Power / Turn on reaper in the morning";
      triggers = [
        {
          at = "07:00:00";
          trigger = "time";
        }
      ];
      conditions = [ (state entities.binary_sensor.reaperPing "off") ];
      actions = [ (call "switch.turn_on" entities.switch.reaperPower { }) ];
    }
    {
      id = "1752228037308";
      alias = "Power / Reaper Windows Button";
      triggers = [
        {
          entity_id = [ entities.input_button.reaperWindows ];
          trigger = "state";
        }
      ];
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
    }
    {
      id = "1761754817178";
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
      actions = notifyPowerChange templates.city_power_off;
    }
    {
      id = "1763747070957";
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
      actions = [
        (announce templates.battery_low { preannounce = true; })
      ];
    }
    {
      id = "1765823486412";
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
      actions = [
        (announce templates.battery_time_low { preannounce = true; })
      ];
    }
    {
      id = "1766322149528";
      alias = "Power / Hoard is offline";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.hoard ];
          from = [ "on" ];
          trigger = "state";
        }
      ];
      actions = [ (announce "Hoard is offline" { }) ];
    }
    {
      id = "1766322208678";
      alias = "Power / Hoard is back online";
      triggers = [
        {
          trigger = "state";
          entity_id = entities.binary_sensor.hoard;
          to = "on";
        }
      ];
      conditions = [ (state entities.input_boolean.fullyLoaded "on") ];
      actions = [ (announce "Hoard is back online." { }) ];
    }
    {
      id = "1768472043250";
      alias = "Power / City power back on";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.cityPower ];
          from = [ "off" ];
          to = [ "on" ];
          trigger = "state";
        }
      ];
      actions = notifyPowerChange templates.city_power_on;
    }
    {
      id = "1763821630644";
      alias = "Voice / Announce battery level via button";
      triggers = [
        (quintuplePress devices.roomLightswitch)
        (quintuplePress devices.roomTableButton)
        (quintuplePress devices.kitchenTableButton)
        (quintuplePress devices.bedButton)
      ];
      actions = [
        (announce templates.battery_level {
          preannounce = false;
        })
      ];
    }
    {
      id = "1787041307832";
      alias = "Voice / Power system Alarm announcement";
      triggers = [
        {
          entity_id = [
            entities.sensor.multiplusHighDcCurrentAlarm
            entities.sensor.multiplusOverloadAlarm
            entities.sensor.multiplusRippleAlarm
            entities.sensor.multiplusHighTemperatureAlarm
            entities.sensor.multiplusTemperatureSensorAlarm
            entities.sensor.multiplusHighDcVoltageAlarm
            entities.sensor.multiplusVoltageSensorAlarm
            entities.sensor.multiplusLowBatteryAlarm
            entities.sensor.batteryCellImbalance
            entities.sensor.batteryHighCellVoltage
            entities.sensor.batteryHighTemperature
            entities.sensor.batteryHighChargeCurrent
            entities.sensor.batteryHighChargeTemperature
            entities.sensor.batteryHighDischargeCurrent
            entities.sensor.batteryLowTemperature
            entities.sensor.batteryLowVoltage
            entities.sensor.batteryLowChargeTemperature
          ];
          to = [ "alarm" ];
          trigger = "state";
        }
      ];
      actions = [
        (announce templates.power_alarm { preannounce = true; })
      ];
    }
  ];
}
