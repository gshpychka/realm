{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    areas
    call
    state
    singlePress
    doublePress
    triplePress
    longPress
    quadruplePress
    ;
  lightTogglePresses = [
    (longPress devices.roomLightswitch)
    (longPress devices.roomTableButton)
    (longPress devices.bedButton)
  ];
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      id = "1735822501432";
      alias = "Lighting / Overhead lights toggle";
      triggers = [
        (singlePress devices.roomLightswitch)
        (triplePress devices.bedButton)
        (doublePress devices.bedShelfButton)
        (quadruplePress devices.kitchenLightswitch)
        (singlePress devices.roomTableButton)
      ];
      actions = [ (call "light.toggle" entities.light.roomOverheadLights { }) ];
    }
    {
      id = "1735822817931";
      alias = "Lighting / Kitchen lights toggle";
      triggers = [
        (singlePress devices.kitchenLightswitch)
        (singlePress devices.kitchenTableButton)
        (quadruplePress devices.roomLightswitch)
        (quadruplePress devices.bedButton)
        (quadruplePress devices.roomTableButton)
      ];
      actions = [ (call "light.toggle" entities.light.kitchenLights { }) ];
    }
    {
      id = "1735822879704";
      alias = "Lighting / Bed light toggle";
      triggers = [
        (singlePress devices.bedButton)
        (singlePress devices.bedShelfButton)
        (triplePress devices.roomLightswitch)
        (triplePress devices.roomTableButton)
      ];
      actions = [ (call "light.toggle" entities.light.bedLight { }) ];
    }
    {
      id = "1736777638584";
      alias = "Lighting / Party light toggle";
      triggers = [
        (triplePress devices.kitchenLightswitch)
        (triplePress devices.kitchenTableButton)
      ];
      actions = [ (call "light.toggle" entities.light.partyLight { }) ];
    }
    {
      id = "1736777817476";
      alias = "Lighting / Room lights full brightness";
      triggers = [
        (doublePress devices.roomLightswitch)
        (doublePress devices.bedButton)
        (doublePress devices.bedShelfButton)
        (doublePress devices.roomTableButton)
      ];
      actions = [
        (call "light.turn_on" entities.light.roomOverheadLights {
          brightness_pct = 100;
          transition = 1;
        })
      ];
    }
    {
      id = "1736777871135";
      alias = "Lighting / Kitchen lights full brightness";
      triggers = [
        (doublePress devices.kitchenLightswitch)
        (doublePress devices.kitchenTableButton)
      ];
      actions = [
        (call "light.turn_on" entities.light.kitchenLights {
          brightness_pct = 100;
          transition = 1;
        })
      ];
    }
    {
      id = "1749390846354";
      alias = "Lighting / Cute lights toggle";
      triggers = lightTogglePresses;
      conditions = [ (state entities.timer.movieSceneOfferWindow "idle") ];
      actions = [ (call "light.toggle" entities.light.cuteLights { }) ];
    }
    {
      id = "1749471372840";
      alias = "Lighting / Turn on plant light";
      triggers = [
        {
          trigger = "time";
          at = "08:00:00";
        }
      ];
      conditions = [ (state entities.light.plantLight "off") ];
      actions = [
        {
          action = "light.turn_on";
          alias = "Turn on Plant light";
          target = {
            entity_id = entities.light.plantLight;
          };
        }
      ];
    }
    {
      id = "1749471809764";
      alias = "Lighting / Turn off plant light";
      triggers = [
        {
          trigger = "time";
          at = "20:00:00";
        }
      ];
      conditions = [ (state entities.light.plantLight "on") ];
      actions = [ (call "light.turn_off" entities.light.plantLight { }) ];
    }
    {
      id = "1755457211035";
      alias = "Lighting / Lava lamp toggle";
      triggers = lightTogglePresses;
      conditions = [ (state entities.timer.movieSceneOfferWindow "idle") ];
      actions = [ (call "light.toggle" entities.light.lavaLamp { }) ];
    }
    {
      id = "1765384948992";
      alias = "Lighting / Flash light when Room assistant starts listening";
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
      actions = [
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = -10; })
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = 10; })
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = -10; })
        (call "light.turn_on" entities.light.overhead4Light { brightness_step_pct = 10; })
      ];
    }
  ];
}
