{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    call
    ;
in
{
  services.home-assistant.config.script = builtins.mapAttrs (_: ha.script) {
    set_air_conditioner_temperature = {
      alias = "Set Air Conditioner temperature";
      description = "Use this to set the Air Conditioner temperature. Use this instead of the Climate entity.";
      fields = {
        target_temperature = {
          description = "Desired temperature setting for the air conditioner in degrees";
          name = "Temperature";
          required = true;
          selector = {
            number = {
              max = 31;
              min = 16;
              step = 1;
            };
          };
        };
      };
      sequence = [
        {
          condition = "template";
          value_template = templates.ac_ready;
        }
        (call "climate.set_temperature" entities.climate.airConditioner {
          temperature = templates.target_temperature;
        })
        (call "climate.set_hvac_mode" entities.climate.airConditioner {
          inherit (templates) hvac_mode;
        })
      ];
    };
  };
}
