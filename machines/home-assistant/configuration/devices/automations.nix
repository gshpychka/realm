{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    devices
    areas
    call
    state
    zha
    announce
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      alias = "Devices / Zigbee router offline";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.slzb06P10Ethernet ];
          from = "on";
          trigger = "state";
        }
      ];
      actions = [ (announce "The Zigbee router is offline" { }) ];
    }
    {
      alias = "Devices / Zigbee is back online";
      triggers = [
        {
          trigger = "state";
          entity_id = entities.binary_sensor.slzb06P10Ethernet;
          to = "on";
        }
      ];
      conditions = [ (state entities.input_boolean.fullyLoaded "on") ];
      actions = [ (announce "The Zigbee router is back online." { }) ];
    }
    {
      alias = "Devices / Water leak detected";
      triggers = [
        {
          trigger = "state";
          entity_id = entities.binary_sensor.leakSensorAMoisture;
          to = "on";
        }
        {
          trigger = "state";
          entity_id = entities.binary_sensor.leakSensorBMoisture;
          to = "on";
        }
      ];
      actions = [
        (call "switch.turn_off" entities.switch.hotWaterValve { })
        (call "switch.turn_off" entities.switch.coldWaterValve { })
        {
          action = "assist_satellite.announce";
          data = {
            message = "Water leak detected!";
          };
          target = {
            device_id = devices.roomVoiceTarget;
          };
        }
        (call "tts.speak" entities.tts.elevenlabs {
          cache = true;
          media_player_entity_id = entities.media_player.allHearingGod;
          message = "Water leak detected!";
        })
        {
          action = "light.turn_on";
          data = {
            brightness_pct = 100;
            flash = "short";
            transition = 0;
          };
          target = {
            area_id = areas.kitchen;
            entity_id = entities.light.roomOverheadLights;
          };
        }
      ];
    }
    {
      alias = "Devices / Zigbee device offline notification";
      triggers = [
        (zha devices.bedButton "device_offline" "device_offline")
        (zha devices.bedShelfButton "device_offline" "device_offline")
        (zha devices.coldWaterValve "device_offline" "device_offline")
        (zha devices.hotWaterValve "device_offline" "device_offline")
        (zha devices.roomLightswitch "device_offline" "device_offline")
        (zha devices.kitchenLightswitch "device_offline" "device_offline")
        (zha devices.kitchenTableButton "device_offline" "device_offline")
      ];
      actions = [
        (announce templates.device_offline { })
      ];
    }
    {
      alias = "Devices / Turn off Dyson Night mode";
      triggers = [
        {
          at = "07:00:00";
          trigger = "time";
        }
      ];
      actions = [ (call "switch.turn_off" entities.switch.dysonNightMode { }) ];
    }
  ];
}
