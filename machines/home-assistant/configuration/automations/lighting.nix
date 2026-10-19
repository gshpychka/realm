{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    areas
    call
    state
    zha
    ;
  longPress = [
    (zha devices.roomLightswitch "remote_button_long_press" "button")
    (zha devices.roomTableButton "remote_button_long_press" "button")
    (zha devices.bedButton "remote_button_long_press" "button")
  ];
in
{
  services.home-assistant.config.automation = [
    {
      actions = [ (call "light.toggle" entities.light.roomOverheadLights { }) ];
      alias = "Lighting / Overhead lights toggle";
      triggers = [
        (zha devices.roomLightswitch "remote_button_short_press" "remote_button_short_press")
        (zha devices.bedButton "remote_button_triple_press" "remote_button_triple_press")
        (zha devices.bedShelfButton "remote_button_double_press" "button_1")
        (zha devices.kitchenLightswitch "remote_button_quadruple_press" "remote_button_quadruple_press")
        (zha devices.roomTableButton "remote_button_short_press" "remote_button_short_press")
      ];
    }
    {
      actions = [ (call "light.toggle" entities.light.kitchenLights { }) ];
      alias = "Lighting / Kitchen lights toggle";
      triggers = [
        (zha devices.kitchenLightswitch "remote_button_short_press" "remote_button_short_press")
        (zha devices.kitchenTableButton "remote_button_short_press" "remote_button_short_press")
        (zha devices.roomLightswitch "remote_button_quadruple_press" "remote_button_quadruple_press")
        (zha devices.bedButton "remote_button_quadruple_press" "remote_button_quadruple_press")
        (zha devices.roomTableButton "remote_button_quadruple_press" "remote_button_quadruple_press")
      ];
    }
    {
      actions = [ (call "light.toggle" entities.light.bedLight { }) ];
      alias = "Lighting / Bed light toggle";
      triggers = [
        (zha devices.bedButton "remote_button_short_press" "remote_button_short_press")
        (zha devices.bedShelfButton "remote_button_short_press" "button_1")
        (zha devices.roomLightswitch "remote_button_triple_press" "remote_button_triple_press")
        (zha devices.roomTableButton "remote_button_triple_press" "remote_button_triple_press")
      ];
    }
    {
      actions = [ (call "light.toggle" entities.light.partyLight { }) ];
      alias = "Lighting / Party light toggle";
      triggers = [
        (zha devices.kitchenLightswitch "remote_button_triple_press" "remote_button_triple_press")
        (zha devices.kitchenTableButton "remote_button_triple_press" "remote_button_triple_press")
      ];
    }
    {
      actions = [
        (call "light.turn_on" entities.light.roomOverheadLights {
          brightness_pct = 100;
          transition = 1;
        })
      ];
      alias = "Lighting / Room lights full brightness";
      triggers = [
        (zha devices.roomLightswitch "remote_button_double_press" "remote_button_double_press")
        (zha devices.bedButton "remote_button_double_press" "remote_button_double_press")
        (zha devices.bedShelfButton "remote_button_double_press" "button_1")
        (zha devices.roomTableButton "remote_button_double_press" "remote_button_double_press")
      ];
    }
    {
      actions = [
        (call "light.turn_on" entities.light.kitchenLights {
          brightness_pct = 100;
          transition = 1;
        })
      ];
      alias = "Lighting / Kitchen lights full brightness";
      triggers = [
        (zha devices.kitchenLightswitch "remote_button_double_press" "remote_button_double_press")
        (zha devices.kitchenTableButton "remote_button_double_press" "remote_button_double_press")
      ];
    }
    {
      actions = [ (call "light.toggle" entities.light.cuteLights { }) ];
      alias = "Lighting / Cute lights toggle";
      conditions = [ (state entities.timer.movieSceneOfferWindow "idle") ];
      triggers = longPress;
    }
    {
      actions = [
        {
          action = "light.turn_on";
          alias = "Turn on Plant light";
          target = {
            entity_id = entities.light.plantLight;
          };
        }
      ];
      alias = "Lighting / Turn on plant light";
      conditions = [ (state entities.light.plantLight "off") ];
      triggers = [
        {
          trigger = "time";
          at = "08:00:00";
        }
      ];
    }
    {
      actions = [ (call "light.turn_off" entities.light.plantLight { }) ];
      alias = "Lighting / Turn off plant light";
      conditions = [ (state entities.light.plantLight "on") ];
      triggers = [
        {
          trigger = "time";
          at = "20:00:00";
        }
      ];
    }
    {
      actions = [ (call "light.toggle" entities.light.lavaLamp { }) ];
      alias = "Lighting / Lava lamp toggle";
      conditions = [ (state entities.timer.movieSceneOfferWindow "idle") ];
      triggers = longPress;
    }
    {
      actions = [
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = -10; })
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = 10; })
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = -10; })
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = 10; })
      ];
      alias = "Lighting / Flash light when Room assistant starts listening";
      conditions = [
        {
          condition = "light.is_on";
          options = {
            behavior = "any";
          };
          target = {
            entity_id = entities.light.roomOverheadLights;
          };
        }
      ];
      triggers = [
        {
          options = {
            behavior = "each";
          };
          target = {
            area_id = areas.room;
          };
          trigger = "assist_satellite.listening";
        }
      ];
    }
  ];
}
