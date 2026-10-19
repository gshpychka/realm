{ entities }:
{
  forecast = {
    output = "list";
    file = "weather/forecast.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
    bindings = {
      OPENWEATHERMAP = entities.weather.openweathermap;
    };
  };
  now_temp = {
    output = "number";
    file = "weather/now-temp.jinja";
    bindings = {
      OPENWEATHERMAP = entities.weather.openweathermap;
    };
  };
  now_feels = {
    output = "number";
    file = "weather/now-feels.jinja";
    bindings = {
      OPENWEATHERMAP = entities.weather.openweathermap;
    };
  };
  now_cond = {
    output = "text";
    file = "weather/now-cond.jinja";
    bindings = {
      OPENWEATHERMAP = entities.weather.openweathermap;
    };
  };
  now_precip = {
    output = "number";
    file = "weather/now-precip.jinja";
    bindings = {
      OPENWEATHERMAP = entities.weather.openweathermap;
    };
  };
  temp_diff = {
    output = "number";
    file = "weather/temp-diff.jinja";
  };
  next_hours = {
    output = "list";
    file = "weather/next-hours.jinja";
  };
  max_temp = {
    output = "number";
    file = "weather/max-temp.jinja";
  };
  min_temp = {
    output = "number";
    file = "weather/min-temp.jinja";
  };
  will_rain = {
    output = "boolean";
    file = "weather/will-rain.jinja";
  };
  condition_change = {
    output = "boolean";
    file = "weather/condition-change.jinja";
  };
  weather_report = {
    output = "text";
    file = "weather/weather-report.jinja";
    bindings = {
      OPENWEATHERMAP = entities.weather.openweathermap;
    };
  };
}
