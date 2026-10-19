{ ha, ... }:
let
  inherit (ha) templates entities call;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
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
      ]
      ++ ha.orderedVariables [
        { fc = templates.forecast; }
        {
          inherit (templates) now_temp;
        }
        {
          inherit (templates) now_feels;
        }
        { inherit (templates) now_cond; }
        {
          inherit (templates) now_precip;
        }
        { diff = templates.temp_diff; }
        { nxt = templates.next_hours; }
        {
          max_t = templates.max_temp;
        }
        {
          min_t = templates.min_temp;
        }
        {
          inherit (templates) will_rain;
        }
        {
          cond_change = templates.condition_change;
        }
        {
          message = templates.weather_report;
        }
      ]
      ++ [
        { set_conversation_response = templates.message; }
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
    }
    {
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
    }
    {
      actions = [ (call "input_boolean.turn_off" entities.input_boolean.fullyLoaded { }) ];
      alias = "System / Disable fully loaded on shutdown";
      triggers = [
        {
          event = "shutdown";
          trigger = "homeassistant";
        }
      ];
    }
  ];
}
