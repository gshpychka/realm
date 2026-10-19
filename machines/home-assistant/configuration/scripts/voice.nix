{
  voice_weather_forecasts_full_llm_script = {
    mode = "parallel";
    max_exceeded = "silent";
    description = "Use this to get the weather forecast for a specific period, or the current weather";
    fields = {
      time_period_type = {
        name = "Time Period Type";
        description = "Use 'daily' in case the request is for full days, examples: today, next Thursday, coming weekend. Use 'hourly' in case the request is for a part of a day, examples: this evening, tonight, next morning, from 3 to 5";
        selector = {
          select = {
            options = [
              "daily"
              "hourly"
            ];
          };
        };
        required = false;
        default = "daily";
      };
      time_period_length = {
        name = "Time Period Length";
        description = "The length of the time period. This will be the number of days in case the 'time_period_type' is 'daily'  and the number of hours in case 'time_period_type' is 'hourly'. Examples: 1 (day) if the request is for the forecast of today, 2 (days) if the request is for the weather this weekend, 6 (hours) if the request is for the weather periods like night, morning, afternoon and evening";
        selector = {
          number = {
            min = 1;
            max = 48;
          };
        };
        required = false;
        default = 5;
      };
      start_date = {
        name = "Start Date";
        description = "The date on which the requested forecast starts. This date should be in the format YYYY-MM-DD.";
        selector = {
          date = { };
        };
        required = true;
      };
      start_time = {
        name = "Start Time";
        description = "The time on which the requested forecast starts. This time should be in the format HH:MM:SS in 24 hour format (for example 17:00:00). Always provide a time. In case a full day is requested, use 00:00:00, in case the current hour is requested, use the start of the hour.\n\"Tonight\" refers to starts at 19:00:00, morning starts at 07:00:00";
        selector = {
          time = { };
        };
        required = true;
      };
    };
    sequence = [
      {
        variables = {
          version = 20250128;
          weather_entity = "weather.openweathermap";
          start_date = "{{ start_date | as_datetime(default='') }}";
          start_time = "{{ start_time | default('00:00:00') | as_timedelta | default('00:00:00', true) }}";
          start = "{{ (start_date | as_datetime + as_timedelta(start_time)) | as_local if start_date else 'NA' }}";
          end = "{% if start != 'NA' %}\n{% set start = as_datetime(start) %}\n{% set add = time_period_length | default(1) | int(1) %}\n{% set type = time_period_type | default if time_period_type | default in ['daily', 'hourly'] else 'daily' %}\n{{ (start + timedelta(days = add if type == 'daily' else 0, hours = add if type == 'hourly' else 0)).isoformat() }}\n{% endif %}";
        };
      }
      {
        alias = "Check if variables were set correctly";
        "if" = [
          {
            condition = "template";
            value_template = "{{ start == 'NA' or end | as_datetime < now() }}";
          }
        ];
        "then" = [
          {
            alias = "Set variable for eror message";
            variables = {
              response = {
                error = "Unable to provide forecast because not all parameters were set by the AI agent";
              };
            };
          }
          {
            alias = "Stop the script";
            stop = "Unable to determine the date for the weather forecast, or the date is in the past";
            response_variable = "response";
          }
        ];
      }
      {
        action = "weather.get_forecasts";
        data = {
          type = "{{ time_period_type }}";
        };
        target = {
          entity_id = "weather.openweathermap";
        };
        response_variable = "weather_response";
      }
      {
        variables = {
          calc_average = false;
          selected_data = {
            forecast = "{% set ns = namespace(forecast=[]) %}\n{% for item in weather_response[weather_entity].forecast %}\n{% if start | as_datetime <= item.datetime | as_datetime | as_local < end | as_datetime %}\n{% set ns.forecast = ns.forecast + [item] %}\n{% endif %}\n{% endfor %} {{ ns.forecast }}";
          };
          averaged = {
            averaged_weather_data_for_period = "{% set ns = namespace(combined={}) %}\n{% set weather_data = selected_data.forecast %}\n{% set forecast_keys = (weather_data[0] | default({})).keys() | reject('eq', 'datetime') %}\n{% for item in forecast_keys %}\n{% set combine = weather_data | map(attribute=item) | list %}\n{% set combine = combine | statistical_mode if combine[0] is string else combine | average | round %}\n{% set ns.combined = dict(ns.combined, **{item: combine}) %}\n{% endfor %}\n{{ dict(start_of_period=start, end_of_period=end, **ns.combined) }}";
          };
          response = "{{ averaged if calc_average else selected_data }}";
        };
      }
      {
        stop = "";
        response_variable = "response";
      }
    ];
    alias = "Weather";
    icon = "mdi:weather-cloudy-clock";
  };
  ask_gpt = {
    alias = "Talk to GPT";
    description = builtins.concatStringsSep "\n" [
      "You can use this to ask an advanced GPT model for assistance with harder questions, especially when the users asks the assistant to \"Ask GPT\" or \"Tell GPT\". "
      "When the user wants to make repeated subsequent requests to GPT, make sure to use the returned `conversation_id` parameter to keep the same conversation going."
    ];
    mode = "parallel";
    max = 3;
    fields = {
      prompt = {
        selector = {
          text = { };
        };
        name = "Prompt";
        description = "The query prompt to pass on to the expert model. Set this to the full question or prompt with all the required context";
        required = true;
      };
      conversation_id = {
        selector = {
          text = { };
        };
        name = "Conversation ID";
        description = "The ID of a previous conversation to continue. Pass the conversation_id from a previous response to continue a previous conversation, retaining all prompt history and context";
      };
    };
    sequence = [
      {
        action = "assist_satellite.announce";
        data = {
          message = "Asking GPT";
          preannounce = false;
        };
        target = {
          device_id = "6711f762ca5f27d9aca0a0cfcdab92ba";
        };
        enabled = false;
      }
      {
        action = "conversation.process";
        data = "{% if conversation_id %} {\"text\": \"{{ prompt }}\", \"agent_id\": \"conversation.chatgpt_expert\", \"conversation_id\": \"{{ conversation_id }}\"} {% else %} {\"text\": \"{{ prompt }}\", \"agent_id\": \"conversation.chatgpt_expert\"} {% endif %}\n";
        response_variable = "gpt_response";
      }
      {
        variables = {
          result = {
            instructions = "Make sure to say that you got the response from GPT. Preface the answer with \"Here\\'s what GPT said: \". Use the returned \"conversaton_id\" in subsequent calls in order to continue this conversation";
            conversation_id = "{{gpt_response.conversation_id}}";
            response = "{{gpt_response.response.speech.plain.speech}}";
          };
        };
      }
      {
        stop = "Complete";
        response_variable = "result";
      }
    ];
  };
  ask_gpt_with_search = {
    alias = "Ask GPT (With search)";
    sequence = [
      {
        action = "conversation.process";
        data = {
          text = "{{prompt}}";
          agent_id = "{{ 'conversation.chatgpt_search' if use_search else 'conversation.chatgpt_expert' }}";
        };
        response_variable = "gpt_response";
      }
      {
        variables = {
          result = {
            instructions = "Make sure to say that you go the response from GPT. Preface the answer with \"Here\\'s what GPT said: \"";
            response = "{{gpt_response.response.speech.plain.speech}}";
          };
        };
      }
      {
        stop = "Complete";
        response_variable = "result";
      }
    ];
    fields = {
      prompt = {
        selector = {
          text = { };
        };
        name = "Prompt";
        description = "The query prompt to ask the expert model. Set this to the full question with all the required context\n";
        required = true;
      };
      use_search = {
        selector = {
          boolean = { };
        };
        name = "Use search";
        description = "Set this to true when the user asks to search for something or mentions search. This can be used to get realtime up-to-date information about the world.";
      };
    };
    description = "You can use this to ask an advanced GPT model for assistance with harder questions, especially when the users asks the assistant to Ask GPT.";
    mode = "parallel";
    max = 3;
  };
  weather_prompt_for_assist_llm = {
    alias = "Weather prompt for Assist LLM";
    mode = "single";
    sequence = [
      {
        target = {
          entity_id = "weather.openweathermap";
        };
        data = {
          type = "hourly";
        };
        response_variable = "wx";
        action = "weather.get_forecasts";
      }
      {
        variables = {
          fc = "{{ wx['weather.openweathermap'].forecast }}";
          now_temp = "{{ state_attr('weather.openweathermap', 'temperature')  | float(0) }}";
          now_feels = "{{ state_attr('weather.openweathermap', 'apparent_temperature') | default(now_temp, true) | float }}";
          now_cond = "{{ states('weather.openweathermap') | default('unknown') }}";
          precip_now = "{{ fc[0].precipitation_probability | default(0) }}";
          nxt = "{{ fc[:6] }}";
          llm_prompt = builtins.concatStringsSep "\n" [
            "## Weather data"
            "current_temperature: {{ now_temp | round(0) }}"
            "current_apparent:   {{ now_feels | round(0) }}"
            "current_condition:  {{ now_cond }}"
            "current_precip_probability: {{ precip_now }}"
            ""
            "{% for h in nxt %}"
            "{{ loop.index }}h:"
            "  time_local: \"{{ (h.datetime | as_datetime | as_local).strftime('%H:%M') }}\""
            "  temperature: {{ h.temperature | round(0) }}"
            "  apparent:    {{ h.apparent_temperature | round(0) }}"
            "  condition:   {{ h.condition }}"
            "  precip_probability: {{ h.precipitation_probability }}"
            "{% endfor %}"
            ""
            "## Instructions (read carefully)"
            "You are Home Assistant’s voice assistant.  "
            "Produce a concise spoken summary (1 – 3 sentences, ≤ 70 words) that:"
            ""
            "• States temperatures with **“degrees Celcius”** spelled out  "
            "• Includes “feels like … degrees Celcius” **only** if the difference ≥ 2 degrees Celcius  "
            "• **Always** states the precipitation probability as “… percent” (spell out “percent”)  "
            "• For the next six hours, mention only *meaningful* changes:"
            "  – temperature swing > 3 degrees Celcius  "
            "  – precipitation probability crosses 20 percent  "
            "  – condition changes (e.g. clear → cloudy)  "
            "• Keep the outlook short; omit redundant detail."
            ""
            "### Examples"
            ""
            "**Example 1 – steady, dry**  "
            "*Data:* 25 → 26 degrees Celcius, clear, 10 percent all six hours.  "
            "*Response:* “It’s 25 degrees Celcius and clear, precipitation probability 10 percent. No significant changes expected in the next few hours.”"
            ""
            "**Example 2 – feels-hot & rain coming**  "
            "*Data:* now 30 (35 feel) ° C, partly cloudy, 15 percent → 60 percent in 3 h.  "
            "*Response:* “It’s 30 degrees Celcius but feels like 35 degrees Celcius under partly-cloudy skies, precipitation probability 15 percent. Expect rain in about three hours as the chance rises to 60 percent.”"
            ""
            "**Example 3 – cooling & rain stopping**  "
            "*Data:* now 18 ° C, light rain 70 percent → clear 10 percent, 14 ° C in 4 h.  "
            "*Response:* “It’s 18 degrees Celcius with light rain, precipitation probability 70 percent. Showers will taper off over the next few hours and temperatures will drop to around 14 degrees Celcius with only 10 percent chance of rain.”"
            ""
            "### End of prompt – craft the final reply now."
          ];
        };
      }
      {
        set_conversation_response = "{{ llm_prompt }}";
      }
    ];
  };
}
