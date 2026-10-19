{ ha, ... }:
let
  inherit (ha) entities automation call;
in
{
  services.home-assistant.config.automation = [
    (automation "system_weather_report" {
      actions = [
        {
          action = "weather.get_forecasts";
          data = {
            type = "hourly";
          };
          response_variable = "wx";
          target = {
            entity_id = entities.weather.openweathermap;
          };
        }
        # HA renders variables in order; Nix attribute sets are sorted.
        { variables.fc = "{{ wx['${entities.weather.openweathermap}'].forecast }}"; }
        {
          variables.now_temp = "{{ state_attr('${entities.weather.openweathermap}', 'temperature')  | float(0) }}";
        }
        {
          variables.now_feels = "{{ state_attr('${entities.weather.openweathermap}', 'apparent_temperature') | default(now_temp, true) | float }}";
        }
        { variables.now_cond = "{{ states('${entities.weather.openweathermap}') | default('unknown') }}"; }
        {
          variables.now_precip = "{{ state_attr('${entities.weather.openweathermap}', 'precipitation') | default(0, true) | float }}";
        }
        { variables.diff = "{{ (now_feels - now_temp) | abs }}"; }
        { variables.nxt = "{{ fc[:6] }}"; }
        {
          variables.max_t = "{{ (nxt | map(attribute='temperature') | list | max) if nxt else now_temp }}";
        }
        {
          variables.min_t = "{{ (nxt | map(attribute='temperature') | list | min) if nxt else now_temp }}";
        }
        {
          variables.will_rain = "{{ nxt | selectattr('precipitation_probability', '>=', 30) | list | count > 0 }}";
        }
        {
          variables.cond_change = "{{ nxt | selectattr('condition', '!=', now_cond) | list | count > 0 }}";
        }
        {
          variables.message = ''
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
        }
        { set_conversation_response = "{{ message }}"; }
      ];
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
    })
    (automation "system_enable_fully_loaded_after_startup" {
      actions = [
        (call "input_boolean.turn_off" entities.input_boolean.fullyLoaded { })
        {
          delay = {
            minutes = 5;
          };
        }
        (call "input_boolean.turn_on" entities.input_boolean.fullyLoaded { })
      ];
      alias = "System / Enable fully loaded after startup";
      triggers = [
        {
          event = "start";
          trigger = "homeassistant";
        }
      ];
    })
    (automation "system_disable_fully_loaded_on_shutdown" {
      actions = [ (call "input_boolean.turn_off" entities.input_boolean.fullyLoaded { }) ];
      alias = "System / Disable fully loaded on shutdown";
      triggers = [
        {
          event = "shutdown";
          trigger = "homeassistant";
        }
      ];
    })
  ];
}
