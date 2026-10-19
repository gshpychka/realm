{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    call
    state
    zha
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
  services.home-assistant.config.automation = [
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
        (announce "Internet provider changed to {{states('${entities.sensor.internetProvider}')}}" { })
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
      actions = [
        # HA renders variables in order; Nix attribute sets are sorted.
        {
          variables.slots = "{{ trigger.slots if trigger is defined and trigger.slots is defined and trigger.slots is mapping else {} }}";
        }
        {
          variables.raw_title = "{{ ((slots.get('movie_title') or slots.get('show_title') or slots.get('title') or '') | string) | regex_replace(' +(on|to|in|into|2) +((my|our|the) +)?(media +)?((plex|duplex)( +(library|collection))?|library|collection|watch ?list)( +please)?$', '', ignorecase=True) | regex_replace(' +please$', '', ignorecase=True) | trim }}";
        }
        {
          variables.raw_type = "{{ 'movie' if slots.get('movie_title') else 'show' if slots.get('show_title') else ((slots.get('media_type') or '') | string | lower | trim) }}";
        }
        {
          variables.media_kind = ''
            {%- set title = raw_title | string -%}
            {%- set first = (title.split(' ', 1)[0] if title else ''') | lower -%}
            {%- if raw_type in ['movie', 'film'] -%} movie
            {%- elif raw_type in ['show', 'series', 'tv', 'tv show', 'tv series'] -%} show
            {%- elif first in ['movie', 'film'] -%} movie
            {%- elif first in ['show', 'series', 'tv', 'television'] -%} show
            {%- else -%} unknown
            {%- endif -%}'';
        }
        {
          variables.clean_title = ''
            {%- if raw_type == ''' and media_kind in ['movie', 'show'] -%}
            {{ raw_title | string | regex_replace('^(movie|film|tv show|tv series|television show|television series|show|series|tv) +', ''', ignorecase=True) }}
            {%- else -%}{{ raw_title | string }}{%- endif -%}'';
        }
        {
          alias = "Stop if this is not a movie or show";
          "if" = [
            {
              alias = "The title is a list or calendar entry";
              condition = "template";
              value_template = "{%- set t = (raw_title | string | lower | trim) -%}{{ t == '' or (t is search('(^| )(to|on|in|into|onto|2) (the|my|our|this) ([^ ]+ )*(list|lists|calendar|reminders?|agenda|notes|schedule|cart|basket|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)$')) or (t is search('(^| )(to|on|for) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow)$')) or (t is search('(^| )(shopping|grocery|groceries|to-do|todo) list( |$)')) }}";
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
                  value_template = "{{ media_kind == 'unknown' }}";
                }
              ];
              sequence = [
                {
                  action = "conversation.process";
                  alias = "Ask LLM to classify media";
                  data = {
                    agent_id = entities.conversation.chatgpt2;
                    text = "You are a classifier. Reply with **exactly one word**: \"movie\" if \"{{ clean_title }}\" is primarily a feature film, \"show\"  if it is primarily a television/streaming series, otherwise \"unknown\". No punctuation. No extra words.";
                  };
                  response_variable = "llm_kind";
                }
                {
                  alias = "set classified media_kind variable";
                  variables = {
                    media_kind = ''
                      {% set kind = (llm_kind.response.speech.plain.speech or ''').lower() %} {{ 'movie' if kind == 'movie'
                         else 'show' if kind == 'show'
                         else 'unknown' }}
                    '';
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
                  value_template = "{{ media_kind == 'unknown' }}";
                }
              ];
              sequence = [
                {
                  alias = "Set response with error message";
                  set_conversation_response = "Sorry, I'm not sure if {{ clean_title }} is a movie or a show.. Try saying, \"Add the movie {{ clean_title }} to my library\".";
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
                      value_template = "{{ media_kind == 'movie' }}";
                    }
                  ];
                  sequence = [
                    {
                      action = "hassarr.add_overseerr_movie";
                      data = {
                        title = "{{ clean_title | title }}";
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
                      value_template = "{{ media_kind == 'show' }}";
                    }
                  ];
                  sequence = [
                    {
                      action = "hassarr.add_overseerr_tv_show";
                      data = {
                        title = "{{ clean_title | title }}";
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
                instructions = ''
                  You're a witty, pop culture–savvy assistant who just helped someone successfully add a {{ media_kind }} to their Plex library. Your job is to confirm the action with a clever, lighthearted, or enthusiastic comment about the {{ media_kind }} they added.
                  The response should:  - clearly confirm the {{ media_kind }} was added - be no more than 2 sentences - mention "{{ clean_title | title }}" naturally - optionally reference the genre, era, or cultural relevance - be friendly and casual, not robotic - only include remarks specifically relevant to the chosen media - let the user know if you are not familiar with the media, and make some
                    witty assumptions based on the title
                  - avoid spoilers or summaries - assume the user already knows what it is - include occasional playful metaphors or niche references - not imply that the media is already available or downloaded - avoid being overly enthusiastic - prefer being slightly sarcastic over dull
                  Example responses: - "The Godfather has been added — your Plex just got a little more respectable." - "Breaking Bad is in. Just remember: no half measures." - "The Matrix? Added to the queue. Hope you've picked the red pill." - "Added Better Call Saul — your library just got 10% more criminally underrated." - "Your copy of Blade Runner is secured. Time to question what it means to be human."
                  Now generate a similar confirmation line for "{{ clean_title | title}}".
                '';
                task_name = "Media added confirmation";
              };
              response_variable = "witty_remark";
            }
            {
              alias = "Set success response";
              set_conversation_response = ''
                {% if witty_remark is defined and witty_remark.data %}
                  {{ witty_remark.data }}
                {% else %}
                  Got it — "{{ clean_title }}" has been added to your {{ media_kind }} queue.
                {% endif %}'';
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
        (announce "Battery is at {{states('${entities.sensor.batteryCharge}')}} percent." {
          preannounce = false;
        })
      ];
      alias = "Voice / Announce battery level via button";
      triggers = [
        (zha devices.roomLightswitch "remote_button_quintuple_press" "remote_button_quintuple_press")
        (zha devices.roomTableButton "remote_button_quintuple_press" "remote_button_quintuple_press")
        (zha devices.kitchenTableButton "remote_button_quintuple_press" "remote_button_quintuple_press")
        (zha devices.bedButton "remote_button_quintuple_press" "remote_button_quintuple_press")
      ];
    }
    {
      actions = [
        (announce ''
          Attention - alarm triggered: {{ trigger.to_state.attributes.friendly_name }}
        '' { preannounce = true; })
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
        { set_conversation_response = "{{ verdict.answer }}"; }
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
