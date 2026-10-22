{ ha, ... }:
let
  inherit (ha)
    entities
    call
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      id = "1749902052905";
      alias = "System / Enable fully loaded after startup";
      triggers = [
        {
          event = "start";
          trigger = "homeassistant";
        }
      ];
      actions = [
        (call "input_boolean.turn_off" entities.input_boolean.fullyLoaded { })
        {
          delay = {
            minutes = 5;
          };
        }
        (call "input_boolean.turn_on" entities.input_boolean.fullyLoaded { })
      ];
    }
    {
      id = "1749902102800";
      alias = "System / Disable fully loaded on shutdown";
      triggers = [
        {
          event = "shutdown";
          trigger = "homeassistant";
        }
      ];
      actions = [ (call "input_boolean.turn_off" entities.input_boolean.fullyLoaded { }) ];
    }
  ];
}
