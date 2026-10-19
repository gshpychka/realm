{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    devices
    call
    state
    announce
    ;
  assistants = [
    entities.select.roomAssistant
    entities.select.kitchenAssistant
  ];
  selectAssistants =
    option: map (entity: call "select.select_option" entity { inherit option; }) assistants;
  notAllAssistants = option: {
    condition = "not";
    conditions = [
      {
        condition = "and";
        conditions = map (entity: state entity option) assistants;
      }
    ];
  };
  voiceTargets = [
    devices.roomVoiceTarget
    devices.kitchenVoiceTarget
  ];
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      alias = "Voice / Moment of silence announcement";
      triggers = [
        {
          at = "08:59:59";
          trigger = "time";
        }
      ];
      actions = [ (announce "It's time for a moment of silence" { preannounce = false; }) ];
    }
    {
      alias = "Voice / Switch to local assistant";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.ollamaStatus ];
          to = "on";
          trigger = "state";
        }
        {
          entity_id = [
            entities.stt.whisperReaper
            entities.tts.openaiTtsKokoro
          ];
          from = "unavailable";
          trigger = "state";
        }
        {
          event = "start";
          trigger = "homeassistant";
        }
      ];
      conditions = [
        (notAllAssistants "Reaper")
        {
          condition = "and";
          conditions = [
            (state entities.binary_sensor.ollamaStatus "on")
            {
              condition = "not";
              conditions = [
                (state entities.stt.whisperReaper "unavailable")
                (state entities.tts.openaiTtsKokoro "unavailable")
              ];
            }
          ];
        }
      ];
      actions = [ { action = "rest_command.ollama_preload"; } ] ++ selectAssistants "Reaper";
    }
    {
      alias = "Voice / Switch to remote assistant";
      triggers = [
        {
          entity_id = [ entities.stt.whisperReaper ];
          to = "unavailable";
          trigger = "state";
        }
        {
          entity_id = [ entities.binary_sensor.ollamaStatus ];
          from = "on";
          trigger = "state";
        }
        {
          entity_id = [ entities.tts.openaiTtsKokoro ];
          to = "unavailable";
          trigger = "state";
        }
      ];
      conditions = [ (notAllAssistants "Remote") ];
      actions = selectAssistants "Remote";
    }
    {
      alias = "Voice / Voice assistant changed to Local announcement";
      triggers = [
        {
          entity_id = [ entities.select.roomAssistant ];
          to = "Reaper";
          trigger = "state";
        }
      ];
      actions = [ (announce "Voice assistant changed to local." { }) ];
    }
    {
      alias = "Voice / Voice assistant changed to Remote announcement";
      triggers = [
        {
          entity_id = [ entities.select.roomAssistant ];
          to = "Remote";
          trigger = "state";
        }
      ];
      actions = [ (announce "Voice assistant changed to remote." { }) ];
    }
    {
      alias = "Voice / Lower voice volume at night";
      triggers = [
        {
          at = "23:00:00";
          trigger = "time";
        }
      ];
      actions = [
        {
          action = "media_player.volume_set";
          data = {
            volume_level = 0.8;
          };
          target = {
            device_id = voiceTargets;
          };
        }
      ];
    }
    {
      alias = "Voice / Set voice volume back to full in the morning";
      triggers = [
        {
          at = "08:00:00";
          trigger = "time";
        }
      ];
      actions = [
        {
          action = "media_player.volume_set";
          data = {
            volume_level = 1;
          };
          target = {
            device_id = voiceTargets;
          };
        }
      ];
    }
    {
      alias = "Voice / Internet provider change announcement";
      triggers = [
        {
          entity_id = [ entities.sensor.internetProvider ];
          for = {
            seconds = 15;
          };
          trigger = "state";
        }
      ];
      conditions = [
        {
          after = "08:00:00";
          before = "23:00:00";
          condition = "time";
        }
        {
          condition = "not";
          conditions = [
            (state entities.sensor.internetProvider "unknown")
            (state entities.sensor.internetProvider "unavailable")
          ];
        }
      ];
      actions = [
        (announce templates.provider_changed { })
      ];
    }
  ];
}
