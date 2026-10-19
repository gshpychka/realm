{
  services.home-assistant.config.automation = [
    {
      id = "1749302876683";
      alias = "System / Weather report";
      triggers = [
        {
          command = [
            "what's the weather"
            "what is the weather"
            "how's the weather"
            "how is the weather"
          ];
          trigger = "conversation";
        }
      ];
      actions = [
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
            now_precip = "{{ state_attr('weather.openweathermap', 'precipitation') | default(0, true) | float }}";
            diff = "{{ (now_feels - now_temp) | abs }}";
            nxt = "{{ fc[:6] }}";
            max_t = "{{ (nxt | map(attribute='temperature') | list | max) if nxt else now_temp }}";
            min_t = "{{ (nxt | map(attribute='temperature') | list | min) if nxt else now_temp }}";
            will_rain = "{{ nxt | selectattr('precipitation_probability', '>=', 30) | list | count > 0 }}";
            cond_change = "{{ nxt | selectattr('condition', '!=', now_cond) | list | count > 0 }}";
            message = ''
              {% set ns = namespace(t=''') %} {# current #} {% set ns.t = ns.t ~ "It's " ~ (now_temp | round(0)) ~ " degrees and " ~ now_cond ~ ". " %} {% if diff > 2 %}
                {% set ns.t = ns.t ~ "Feels like " ~ (now_feels | round(0)) ~ " degrees. " %}
              {% endif %} {% if now_precip > 0 %}
                {% set ns.t = ns.t ~ "There's precipitation right now. " %}
              {% endif %} {# next 6 h #} {% if will_rain %}
                {% set ns.t = ns.t ~ "Rain is likely within the next few hours. " %}
              {% endif %} {% if (max_t - now_temp) > 3 %}
                {% set ns.t = ns.t ~ "It will warm up to about " ~ (max_t | round(0)) ~ " degrees in the next six hours. " %}
              {% elif (now_temp - min_t) > 3 %}
                {% set ns.t = ns.t ~ "Expect it to cool down to around " ~ (min_t | round(0)) ~ " degrees in the next six hours. " %}
              {% endif %} {{ ns.t | trim }}'';
          };
        }
        {
          set_conversation_response = "{{ message }}";
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1749902052905";
      alias = "System / Enable fully loaded after startup";
      triggers = [
        {
          trigger = "homeassistant";
          event = "start";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "input_boolean.turn_off";
          data = { };
          target = {
            entity_id = "input_boolean.homeassistant_fully_loaded";
          };
        }
        {
          delay = {
            hours = 0;
            minutes = 5;
            seconds = 0;
            milliseconds = 0;
          };
        }
        {
          action = "input_boolean.turn_on";
          data = { };
          target = {
            entity_id = "input_boolean.homeassistant_fully_loaded";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1749902102800";
      alias = "System / Disable fully loaded on shutdown";
      triggers = [
        {
          trigger = "homeassistant";
          event = "shutdown";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "input_boolean.turn_off";
          data = { };
          target = {
            entity_id = "input_boolean.homeassistant_fully_loaded";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
  ];
}
