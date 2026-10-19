{
  entities,
  literal,
  mk,
  fields,
}:
{
  forecast = fields "list" "{% set fc = dig(wx | default(none), [${literal entities.weather.openweathermap}, 'forecast']) %}{{ fc if fc is sequence and fc is not string and fc is not mapping else [] }}";
  now_temp = mk "number" "{% set t = state_attr(${literal entities.weather.openweathermap}, 'temperature') %}{{ t | float if is_number(t) else 0 }}";
  now_feels = mk "number" "{% set t = state_attr(${literal entities.weather.openweathermap}, 'apparent_temperature') %}{{ t | float if is_number(t) else now_temp }}";
  now_cond = mk "text" "{{ states(${literal entities.weather.openweathermap}) | default('unknown') }}";
  now_precip = mk "number" "{% set p = state_attr(${literal entities.weather.openweathermap}, 'precipitation') %}{{ p | float if is_number(p) else 0 }}";
  temp_diff = mk "number" "{{ (now_feels - now_temp) | abs }}";
  next_hours = mk "list" "{{ fc[:6] }}";
  max_temp = mk "number" "{% set ts = nxt | select('mapping') | selectattr('temperature', 'defined') | map(attribute='temperature') | select('is_number') | map('float') | list %}{{ ts | max if ts else now_temp }}";
  min_temp = mk "number" "{% set ts = nxt | select('mapping') | selectattr('temperature', 'defined') | map(attribute='temperature') | select('is_number') | map('float') | list %}{{ ts | min if ts else now_temp }}";
  will_rain = mk "boolean" "{{ nxt | select('mapping') | selectattr('precipitation_probability', 'defined') | selectattr('precipitation_probability', 'is_number') | map(attribute='precipitation_probability') | map('float') | select('>=', 30) | list | count > 0 }}";
  condition_change = mk "boolean" "{{ nxt | select('mapping') | selectattr('condition', 'defined') | selectattr('condition', '!=', now_cond) | list | count > 0 }}";
  weather_report = mk "text" ''
    {%- set ns = namespace(t=''') -%}
    {# current #}
    {%- if is_number(state_attr(${literal entities.weather.openweathermap}, 'temperature')) -%}
      {%- set ns.t = ns.t ~ "It's " ~ (now_temp | round(0)) ~ " degrees and " ~ now_cond ~ ". " -%}
    {%- else -%}
      {%- set ns.t = 'Current weather information is unavailable. ' -%}
    {%- endif -%}
    {%- if diff > 2 -%}
      {%- set ns.t = ns.t ~ "Feels like " ~ (now_feels | round(0)) ~ " degrees. " -%}
    {%- endif -%}
    {%- if now_precip > 0 -%}
      {%- set ns.t = ns.t ~ "There's precipitation right now. " -%}
    {%- endif -%}
    {# next 6 h #}
    {%- if will_rain -%}
      {%- set ns.t = ns.t ~ "Rain is likely within the next few hours. " -%}
    {%- endif -%}
    {%- if (max_t - now_temp) > 3 -%}
      {%- set ns.t = ns.t ~ "It will warm up to about " ~ (max_t | round(0)) ~ " degrees in the next six hours. " -%}
    {%- elif (now_temp - min_t) > 3 -%}
      {%- set ns.t = ns.t ~ "Expect it to cool down to around " ~ (min_t | round(0)) ~ " degrees in the next six hours. " -%}
    {%- endif -%}
    {{ ns.t | trim }}'';
}
