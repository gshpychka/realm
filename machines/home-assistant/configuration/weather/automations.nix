{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
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
          action = "weather.get_forecasts";
          # A failed provider must still reach the unavailable-weather response.
          continue_on_error = true;
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
    }
  ];
}
