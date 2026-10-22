{ entities }:
{
  fan_speed = {
    output = "number-or-unknown";
    file = "climate/fan-speed.jinja";
  };
  ac_ready = {
    output = "boolean";
    file = "climate/ac-ready.jinja";
    bindings = {
      AIR_CONDITIONER = entities.climate.airConditioner;
    };
  };
  target_temperature = {
    output = "number";
    file = "climate/target-temperature.jinja";
  };
  hvac_mode = {
    output = "text";
    file = "climate/hvac-mode.jinja";
    bindings = {
      AIR_CONDITIONER = entities.climate.airConditioner;
    };
  };
}
