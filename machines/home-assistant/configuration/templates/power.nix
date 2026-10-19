{
  entities,
  literal,
  mk,
  fields,
}:
{
  city_power_off = mk "text" ''
    {%- set schedule = states(${literal entities.sensor.yasnoPower}) -%}
    {%- set restoration = as_datetime(states(${literal entities.sensor.yasnoNextPower}), none) -%}
    {%- set remaining = (as_timestamp(restoration) - as_timestamp(now())) if restoration is not none else none -%}
    {%- set hours = (remaining / 3600) | round(0) | int if remaining is not none else 0 -%}
    City power is off.
    {% if schedule == 'outage' %}
      This is a scheduled outage.
      {% if remaining is not none and remaining > 0 %}
        {% if remaining < 3600 %}Power should be back on in less than an hour.
        {% else %}Power should be back on in about {{ hours }} {{ 'hour' if hours == 1 else 'hours' }}.{% endif %}
      {% else %}No information about how long the outage will last.{% endif %}
    {% elif schedule == 'normal' %}This is not a scheduled outage.
    {% else %}The outage schedule is unavailable, so I cannot confirm whether this outage is scheduled.{% endif %}
    Battery is at {{ states(${literal entities.sensor.batteryCharge}) | int('unknown') }} percent.
    Current power draw is {{ states(${literal entities.sensor.multiplusOutputPowerL1}) }} Watts.
  '';
  battery_low = mk "text" "Warning: The battery level is - {{states(${literal entities.sensor.batteryCharge}) | int('unknown') }}  percent...";
  battery_time_low = mk "text" "Warning: Less than one hour of battery power remaining. Battery is at {{ (states(${literal entities.sensor.batteryCharge}) | float | round(0)) if is_number(states(${literal entities.sensor.batteryCharge})) else 'unknown' }} percent.";
  city_power_on = mk "text" "Power is back on. Battery is at {{states(${literal entities.sensor.batteryCharge}) | int('unknown') }} percent.";
  battery_level = mk "text" "Battery is at {{states(${literal entities.sensor.batteryCharge})}} percent.";
  power_alarm = fields "text" ''
    Attention - alarm triggered: {{ dig(trigger | default(none), ['to_state', 'attributes', 'friendly_name']) | default('Power system', true) }}
  '';
}
