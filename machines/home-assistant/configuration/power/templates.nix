{ entities }:
{
  city_power_off = {
    output = "text";
    file = "power/city-power-off.jinja";
    bindings = {
      YASNO_POWER = entities.sensor.yasnoPower;
      YASNO_NEXT_POWER = entities.sensor.yasnoNextPower;
      BATTERY_CHARGE = entities.sensor.batteryCharge;
      MULTIPLUS_OUTPUT_POWER_L1 = entities.sensor.multiplusOutputPowerL1;
    };
  };
  battery_low = {
    output = "text";
    file = "power/battery-low.jinja";
    bindings = {
      BATTERY_CHARGE = entities.sensor.batteryCharge;
    };
  };
  battery_time_low = {
    output = "text";
    file = "power/battery-time-low.jinja";
    bindings = {
      BATTERY_CHARGE = entities.sensor.batteryCharge;
    };
  };
  city_power_on = {
    output = "text";
    file = "power/city-power-on.jinja";
    bindings = {
      BATTERY_CHARGE = entities.sensor.batteryCharge;
    };
  };
  battery_level = {
    output = "text";
    file = "power/battery-level.jinja";
    bindings = {
      BATTERY_CHARGE = entities.sensor.batteryCharge;
    };
  };
  power_alarm = {
    output = "text";
    file = "power/power-alarm.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
}
