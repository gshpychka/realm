{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    devices
    call
    state
    quintuplePress
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
      actions = [ (announce "It's time for a moment of silence" { preannounce = false; }) ];
      alias = "Voice / Moment of silence announcement";
      triggers = [
        {
          at = "08:59:59";
          trigger = "time";
        }
      ];
    }
    {
      actions = [ { action = "rest_command.ollama_preload"; } ] ++ selectAssistants "Reaper";
      alias = "Voice / Switch to local assistant";
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
    }
    {
      actions = selectAssistants "Remote";
      alias = "Voice / Switch to remote assistant";
      conditions = [ (notAllAssistants "Remote") ];
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
    }
    {
      actions = [ (announce "Voice assistant changed to local." { }) ];
      alias = "Voice / Voice assistant changed to Local announcement";
      triggers = [
        {
          entity_id = [ entities.select.roomAssistant ];
          to = "Reaper";
          trigger = "state";
        }
      ];
    }
    {
      actions = [ (announce "Voice assistant changed to remote." { }) ];
      alias = "Voice / Voice assistant changed to Remote announcement";
      triggers = [
        {
          entity_id = [ entities.select.roomAssistant ];
          to = "Remote";
          trigger = "state";
        }
      ];
    }
    {
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
      alias = "Voice / Lower voice volume at night";
      triggers = [
        {
          at = "23:00:00";
          trigger = "time";
        }
      ];
    }
    {
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
      alias = "Voice / Set voice volume back to full in the morning";
      triggers = [
        {
          at = "08:00:00";
          trigger = "time";
        }
      ];
    }
    {
      actions = [
        (announce templates.provider_changed { })
      ];
      alias = "Voice / Internet provider change announcement";
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
      triggers = [
        {
          entity_id = [ entities.sensor.internetProvider ];
          for = {
            seconds = 15;
          };
          trigger = "state";
        }
      ];
    }
    {
      actions =
        ha.orderedVariables [
          {
            inherit (templates) slots;
          }
          {
            inherit (templates) raw_title;
          }
          {
            inherit (templates) raw_type;
          }
          {
            inherit (templates) media_kind;
          }
          {
            inherit (templates) clean_title;
          }
        ]
        ++ [
          {
            alias = "Stop if this is not a movie or show";
            "if" = [
              {
                alias = "The title is a list or calendar entry";
                condition = "template";
                value_template = templates.reject_media;
              }
            ];
            "then" = [
              {
                alias = "Say nothing was added";
                set_conversation_response = "That sounds like a list or calendar item, not a movie or show, so I didn't add anything.";
              }
              { stop = "Not a media request"; }
            ];
          }
          {
            alias = "Classify media kind via LLM if necessary";
            choose = [
              {
                alias = "Necessary";
                conditions = [
                  {
                    alias = "media_kind is unknown";
                    condition = "template";
                    value_template = templates.unknown_media;
                  }
                ];
                sequence = [
                  {
                    action = "conversation.process";
                    alias = "Ask LLM to classify media";
                    data = {
                      agent_id = entities.conversation.chatgpt2;
                      text = templates.classifier_prompt;
                    };
                    response_variable = "llm_kind";
                  }
                  {
                    alias = "set classified media_kind variable";
                    variables = {
                      media_kind = templates.classified_media;
                    };
                  }
                ];
              }
            ];
          }
          {
            choose = [
              {
                alias = "media_kind is STILL unknown";
                conditions = [
                  {
                    alias = "media_kind is unknown";
                    condition = "template";
                    value_template = templates.unknown_media;
                  }
                ];
                sequence = [
                  {
                    alias = "Set response with error message";
                    set_conversation_response = templates.unsure_media;
                  }
                ];
              }
            ];
            default = [
              {
                alias = "Choose between movie or show";
                choose = [
                  {
                    alias = "Movie";
                    conditions = [
                      {
                        alias = "media_kind is movie";
                        condition = "template";
                        value_template = templates.movie_media;
                      }
                    ];
                    sequence = [
                      {
                        action = "hassarr.add_overseerr_movie";
                        data = {
                          title = templates.title_case;
                        };
                      }
                    ];
                  }
                  {
                    alias = "Show";
                    conditions = [
                      {
                        alias = "media_kind is show";
                        condition = "template";
                        value_template = templates.show_media;
                      }
                    ];
                    sequence = [
                      {
                        action = "hassarr.add_overseerr_tv_show";
                        data = {
                          title = templates.title_case;
                        };
                      }
                    ];
                  }
                ];
              }
              {
                action = "ai_task.generate_data";
                alias = "Ask for a joke";
                data = {
                  entity_id = entities.ai_task.openaiAiTask;
                  instructions = templates.confirmation_prompt;
                  task_name = "Media added confirmation";
                };
                response_variable = "witty_remark";
              }
              {
                alias = "Set success response";
                set_conversation_response = templates.media_confirmation;
              }
            ];
          }
        ];
      alias = "Voice / Add media using Assist";
      triggers = [
        {
          command = [
            "(download|add|send) [the] (movie|film) {movie_title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
            "(download|add|send) [the] [tv|television] (show|series) {show_title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
            "(download|add) [the] (movie|film) {movie_title}"
            "(download|add) [the] [tv|television] (show|series) {show_title}"
            "(download|add|send) [the] {title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
          ];
          trigger = "conversation";
        }
      ];
    }
    {
      actions = [
        (announce templates.battery_level {
          preannounce = false;
        })
      ];
      alias = "Voice / Announce battery level via button";
      triggers = [
        (quintuplePress devices.roomLightswitch)
        (quintuplePress devices.roomTableButton)
        (quintuplePress devices.kitchenTableButton)
        (quintuplePress devices.bedButton)
      ];
    }
    {
      actions = [
        (announce templates.power_alarm { preannounce = true; })
      ];
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
    }
    {
      actions = [
        {
          action = "script.check_print";
          response_variable = "verdict";
        }
        { set_conversation_response = templates.print_answer; }
      ];
      alias = "Voice / Print check by voice";
      description = "Answers spoken questions about the running print with a camera-based verdict.";
      max_exceeded = "silent";
      triggers = [
        {
          command = [
            "(how's|how is) [the|my] print (going|looking|doing)"
            "how does [the|my] print look"
            "what does [the|my] print look like"
            "check [on] [the|my] print"
            "(how's|how is) [the] printer doing"
            "look at [the|my] print"
            "(how's|how is) [the|my] print"
            "(what's|what is) [the|my] print doing"
            "is [the|my] print (ok|okay|alright|fine|going well)"
          ];
          trigger = "conversation";
        }
      ];
    }
  ];
}
