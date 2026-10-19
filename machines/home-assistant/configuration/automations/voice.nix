{ haDevices, ... }:
{
  services.home-assistant.config.automation = [
    {
      id = "1735974440260";
      alias = "Voice / Moment of silence announcement";
      triggers = [
        {
          trigger = "time";
          at = "08:59:59";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "tts.cloud_say";
          data = {
            cache = true;
            entity_id = "media_player.home_assistant_voice_media_player";
            message = "It's time for a moment of silence";
          };
          enabled = false;
        }
        {
          action = "assist_satellite.announce";
          data = {
            preannounce = false;
            message = "It's time for a moment of silence";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740237487651";
      alias = "Voice / Switch to local assistant";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.ollama_status"
          ];
          to = "on";
          from = null;
          for = {
            hours = 0;
            minutes = 0;
            seconds = 0;
          };
        }
        {
          trigger = "state";
          entity_id = [
            "stt.whisper_reaper"
            "tts.openai_tts_kokoro"
          ];
          from = "unavailable";
          to = null;
        }
        {
          trigger = "homeassistant";
          event = "start";
        }
      ];
      conditions = [
        {
          alias = "Not all assistants are Local";
          condition = "not";
          conditions = [
            {
              alias = "All assistants are Local";
              condition = "and";
              conditions = [
                {
                  condition = "state";
                  entity_id = "select.home_assistant_voice_09e1bb_assistant";
                  state = "Reaper";
                  alias = "Kitchen assistant is Local";
                }
                {
                  condition = "state";
                  entity_id = "select.room_assistant_assistant";
                  state = "Reaper";
                  alias = "Room assistant is Local";
                }
              ];
            }
          ];
        }
        {
          condition = "and";
          conditions = [
            {
              condition = "state";
              entity_id = "binary_sensor.ollama_status";
              state = "on";
            }
            {
              condition = "not";
              conditions = [
                {
                  condition = "state";
                  entity_id = "stt.whisper_reaper";
                  state = "unavailable";
                }
                {
                  condition = "state";
                  entity_id = "tts.openai_tts_kokoro";
                  state = "unavailable";
                }
              ];
            }
          ];
        }
      ];
      actions = [
        {
          action = "rest_command.ollama_preload";
          data = { };
        }
        {
          device_id = "6711f762ca5f27d9aca0a0cfcdab92ba";
          domain = "select";
          entity_id = "83ef9a459c7fb5a44f3e67e1599fd9b3";
          type = "select_option";
          option = "Reaper";
        }
        {
          device_id = "e2a9b5f6b3842bc75aa39038200b8a79";
          domain = "select";
          entity_id = "4cff975a12a3a5bbaf2a3ab180cf9b82";
          type = "select_option";
          option = "Reaper";
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740237609917";
      alias = "Voice / Switch to remote assistant";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "stt.whisper_reaper"
          ];
          to = "unavailable";
          from = null;
          enabled = true;
        }
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.ollama_status"
          ];
          from = "on";
          to = null;
        }
        {
          trigger = "state";
          entity_id = [
            "tts.openai_tts_kokoro"
          ];
          to = "unavailable";
          from = null;
        }
      ];
      conditions = [
        {
          condition = "not";
          conditions = [
            {
              condition = "and";
              conditions = [
                {
                  condition = "state";
                  entity_id = "select.room_assistant_assistant";
                  state = "Remote";
                }
                {
                  condition = "state";
                  entity_id = "select.home_assistant_voice_09e1bb_assistant";
                  state = "Remote";
                }
              ];
              alias = "Both assistant are Remote";
            }
          ];
          alias = "Not all assistants are remote";
        }
      ];
      actions = [
        {
          device_id = "6711f762ca5f27d9aca0a0cfcdab92ba";
          domain = "select";
          entity_id = "83ef9a459c7fb5a44f3e67e1599fd9b3";
          type = "select_option";
          option = "Remote";
        }
        {
          device_id = "e2a9b5f6b3842bc75aa39038200b8a79";
          domain = "select";
          entity_id = "4cff975a12a3a5bbaf2a3ab180cf9b82";
          type = "select_option";
          option = "Remote";
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740514715257";
      alias = "Voice / Voice assistant changed to Local announcement";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "select.room_assistant_assistant"
          ];
          from = null;
          to = "Reaper";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Voice assistant changed to local.";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740514774923";
      alias = "Voice / Voice assistant changed to Remote announcement";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "select.room_assistant_assistant"
          ];
          from = null;
          to = "Remote";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Voice assistant changed to remote.";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740518420448";
      alias = "Voice / Lower voice volume at night";
      triggers = [
        {
          trigger = "time";
          at = "23:00:00";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "media_player.volume_set";
          data = {
            volume_level = 0.8;
          };
          target = {
            device_id = [
              "6711f762ca5f27d9aca0a0cfcdab92ba"
              "e2a9b5f6b3842bc75aa39038200b8a79"
            ];
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740518452668";
      alias = "Voice / Set voice volume back to full in the morning";
      triggers = [
        {
          trigger = "time";
          at = "08:00:00";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "media_player.volume_set";
          data = {
            volume_level = 1;
          };
          target = {
            device_id = [
              "6711f762ca5f27d9aca0a0cfcdab92ba"
              "e2a9b5f6b3842bc75aa39038200b8a79"
            ];
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1742134027344";
      alias = "Voice / Internet provider change announcement";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "sensor.internet_provider"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 15;
          };
        }
      ];
      conditions = [
        {
          condition = "time";
          after = "08:00:00";
          before = "23:00:00";
        }
        {
          condition = "not";
          conditions = [
            {
              condition = "state";
              entity_id = "sensor.internet_provider";
              state = "unknown";
            }
            {
              condition = "state";
              entity_id = "sensor.internet_provider";
              state = "unavailable";
            }
          ];
        }
      ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            message = "Internet provider changed to {{states('sensor.internet_provider')}}";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1746203147558";
      alias = "Voice / Add media using Assist";
      triggers = [
        {
          trigger = "conversation";
          command = [
            "(download|add|send) [the] (movie|film) {movie_title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
            "(download|add|send) [the] [tv|television] (show|series) {show_title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
            "(download|add) [the] (movie|film) {movie_title}"
            "(download|add) [the] [tv|television] (show|series) {show_title}"
            "(download|add|send) [the] {title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
          ];
        }
      ];
      actions = [
        {
          variables = {
            slots = "{{ trigger.slots if trigger is defined and trigger.slots is defined and trigger.slots is mapping else {} }}";
            raw_title = "{{ ((slots.get('movie_title') or slots.get('show_title') or slots.get('title') or '') | string) | regex_replace(' +(on|to|in|into|2) +((my|our|the) +)?(media +)?((plex|duplex)( +(library|collection))?|library|collection|watch ?list)( +please)?$', '', ignorecase=True) | regex_replace(' +please$', '', ignorecase=True) | trim }}";
            raw_type = "{{ 'movie' if slots.get('movie_title') else 'show' if slots.get('show_title') else ((slots.get('media_type') or '') | string | lower | trim) }}";
            media_kind = ''
              {%- set title = raw_title | string -%}
              {%- set first = (title.split(' ', 1)[0] if title else ''') | lower -%}
              {%- if raw_type in ['movie', 'film'] -%} movie
              {%- elif raw_type in ['show', 'series', 'tv', 'tv show', 'tv series'] -%} show
              {%- elif first in ['movie', 'film'] -%} movie
              {%- elif first in ['show', 'series', 'tv', 'television'] -%} show
              {%- else -%} unknown
              {%- endif -%}'';
            clean_title = ''
              {%- if raw_type == ''' and media_kind in ['movie', 'show'] -%}
              {{ raw_title | string | regex_replace('^(movie|film|tv show|tv series|television show|television series|show|series|tv) +', ''', ignorecase=True) }}
              {%- else -%}{{ raw_title | string }}{%- endif -%}'';
          };
        }
        {
          alias = "Stop if this is not a movie or show";
          "if" = [
            {
              condition = "template";
              value_template = "{%- set t = (raw_title | string | lower | trim) -%}{{ t == '' or (t is search('(^| )(to|on|in|into|onto|2) (the|my|our|this) ([^ ]+ )*(list|lists|calendar|reminders?|agenda|notes|schedule|cart|basket|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)$')) or (t is search('(^| )(to|on|for) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow)$')) or (t is search('(^| )(shopping|grocery|groceries|to-do|todo) list( |$)')) }}";
              alias = "The title is a list or calendar entry";
            }
          ];
          "then" = [
            {
              set_conversation_response = "That sounds like a list or calendar item, not a movie or show, so I didn't add anything.";
              alias = "Say nothing was added";
            }
            {
              stop = "Not a media request";
            }
          ];
        }
        {
          alias = "Classify media kind via LLM if necessary";
          choose = [
            {
              conditions = [
                {
                  condition = "template";
                  value_template = "{{ media_kind == 'unknown' }}";
                  alias = "media_kind is unknown";
                }
              ];
              sequence = [
                {
                  action = "conversation.process";
                  data = {
                    text = "You are a classifier. Reply with **exactly one word**: \"movie\" if \"{{ clean_title }}\" is primarily a feature film, \"show\"  if it is primarily a television/streaming series, otherwise \"unknown\". No punctuation. No extra words.";
                    agent_id = "conversation.chatgpt_2";
                  };
                  response_variable = "llm_kind";
                  alias = "Ask LLM to classify media";
                }
                {
                  variables = {
                    media_kind = ''
                      {% set kind = (llm_kind.response.speech.plain.speech or ''').lower() %} {{ 'movie' if kind == 'movie'
                         else 'show' if kind == 'show'
                         else 'unknown' }}
                    '';
                  };
                  alias = "set classified media_kind variable";
                }
              ];
              alias = "Necessary";
            }
          ];
        }
        {
          choose = [
            {
              conditions = [
                {
                  condition = "template";
                  value_template = "{{ media_kind == 'unknown' }}";
                  alias = "media_kind is unknown";
                }
              ];
              sequence = [
                {
                  set_conversation_response = "Sorry, I'm not sure if {{ clean_title }} is a movie or a show.. Try saying, \"Add the movie {{ clean_title }} to my library\".";
                  alias = "Set response with error message";
                }
                {
                  action = "assist_satellite.ask_question";
                  data = {
                    question = "Is {{ clean_title }} a movie, or a show?";
                    preannounce = false;
                    entity_id = "assist_satellite.room_assistant_assist_satellite";
                    answers = [
                      {
                        id = "movie";
                        sentences = [
                          "movie"
                          "film"
                        ];
                      }
                      {
                        id = "show";
                        sentences = [
                          "TV"
                          "series"
                        ];
                      }
                    ];
                  };
                  response_variable = "media_kind";
                  enabled = false;
                  alias = "Ask for clarification directly";
                }
              ];
              alias = "media_kind is STILL unknown";
            }
          ];
          default = [
            {
              alias = "Choose between movie or show";
              choose = [
                {
                  conditions = [
                    {
                      condition = "template";
                      value_template = "{{ media_kind == 'movie' }}";
                      alias = "media_kind is movie";
                    }
                  ];
                  sequence = [
                    {
                      data = {
                        title = "{{ clean_title | title }}";
                      };
                      action = "hassarr.add_overseerr_movie";
                    }
                  ];
                  alias = "Movie";
                }
                {
                  conditions = [
                    {
                      condition = "template";
                      value_template = "{{ media_kind == 'show' }}";
                      alias = "media_kind is show";
                    }
                  ];
                  sequence = [
                    {
                      data = {
                        title = "{{ clean_title | title }}";
                      };
                      action = "hassarr.add_overseerr_tv_show";
                    }
                  ];
                  alias = "Show";
                }
              ];
            }
            {
              action = "ai_task.generate_data";
              response_variable = "witty_remark";
              data = {
                entity_id = "ai_task.openai_ai_task";
                task_name = "Media added confirmation";
                instructions = ''
                  You're a witty, pop culture–savvy assistant who just helped someone successfully add a {{ media_kind }} to their Plex library. Your job is to confirm the action with a clever, lighthearted, or enthusiastic comment about the {{ media_kind }} they added.
                  The response should:  - clearly confirm the {{ media_kind }} was added - be no more than 2 sentences - mention "{{ clean_title | title }}" naturally - optionally reference the genre, era, or cultural relevance - be friendly and casual, not robotic - only include remarks specifically relevant to the chosen media - let the user know if you are not familiar with the media, and make some
                    witty assumptions based on the title
                  - avoid spoilers or summaries - assume the user already knows what it is - include occasional playful metaphors or niche references - not imply that the media is already available or downloaded - avoid being overly enthusiastic - prefer being slightly sarcastic over dull
                  Example responses: - "The Godfather has been added — your Plex just got a little more respectable." - "Breaking Bad is in. Just remember: no half measures." - "The Matrix? Added to the queue. Hope you've picked the red pill." - "Added Better Call Saul — your library just got 10% more criminally underrated." - "Your copy of Blade Runner is secured. Time to question what it means to be human."
                  Now generate a similar confirmation line for "{{ clean_title | title}}".
                '';
              };
              alias = "Ask for a joke";
            }
            {
              set_conversation_response = ''
                {% if witty_remark is defined and witty_remark.data %}
                  {{ witty_remark.data }}
                {% else %}
                  Got it — "{{ clean_title }}" has been added to your {{ media_kind }} queue.
                {% endif %}'';
              alias = "Set success response";
            }
          ];
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1763821630644";
      alias = "Voice / Announce battery level via button";
      triggers = [
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_quintuple_press";
          subtype = "remote_button_quintuple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.roomLightswitch;
          domain = "zha";
          type = "remote_button_quintuple_press";
          subtype = "remote_button_quintuple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_quintuple_press";
          subtype = "remote_button_quintuple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.kitchenTableButton;
          domain = "zha";
          type = "remote_button_quintuple_press";
          subtype = "remote_button_quintuple_press";
          trigger = "device";
        }
        {
          device_id = haDevices.bedButton;
          domain = "zha";
          type = "remote_button_quintuple_press";
          subtype = "remote_button_quintuple_press";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          data = {
            preannounce = false;
            message = "Battery is at {{states('sensor.battery_charge')}} percent.";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1787041307832";
      alias = "Voice / Power system Alarm announcement";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "sensor.multiplus_high_dc_current_alarm"
            "sensor.multiplus_overload_alarm"
            "sensor.multiplus_ripple_alarm"
            "sensor.multiplus_high_temperature_alarm"
            "sensor.multiplus_temperature_sensor_alarm"
            "sensor.multiplus_high_dc_voltage_alarm"
            "sensor.multiplus_voltage_sensor_alarm"
            "sensor.multiplus_low_battery_alarm"
            "sensor.battery_cell_imbalance"
            "sensor.battery_high_cell_voltage"
            "sensor.battery_high_temperature"
            "sensor.battery_high_charge_current"
            "sensor.battery_high_charge_temperature"
            "sensor.battery_high_discharge_current"
            "sensor.battery_low_temperature"
            "sensor.battery_low_voltage"
            "sensor.battery_low_charge_temperature"
          ];
          from = null;
          to = [
            "alarm"
          ];
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          target = {
            area_id = "room";
          };
          data = {
            preannounce = true;
            message = ''
              Attention - alarm triggered: {{ trigger.to_state.attributes.friendly_name }}
            '';
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1787590347448";
      alias = "Voice / Print check by voice";
      description = "Answers spoken questions about the running print with a camera-based verdict.";
      triggers = [
        {
          trigger = "conversation";
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
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "script.check_print";
          response_variable = "verdict";
        }
        {
          set_conversation_response = "{{ verdict.answer }}";
        }
      ];
      mode = "single";
      max_exceeded = "silent";
      initial_state = true;
    }
  ];
}
