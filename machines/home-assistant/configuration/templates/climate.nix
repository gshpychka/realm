{
  entities,
  literal,
  mk,
}:
{
  fan_speed = mk "number-or-unknown" "{% set parts = (value | default('') | string).split() %}{{ parts[0] | int if parts and is_number(parts[0]) and 0 <= parts[0] | float <= 100 else 'unknown' }}";
  ac_ready = mk "boolean" "{{ target_temperature is defined and target_temperature is number and target_temperature is not boolean and 16 <= target_temperature <= 31 and is_number(state_attr(${literal entities.climate.airConditioner}, 'current_temperature')) }}";
  target_temperature = mk "number" "{{ target_temperature | float(0) }}";
  hvac_mode = mk "text" ''
    {{ ('cool' if (state_attr(${literal entities.climate.airConditioner}, 'current_temperature') | float(0)) > target_temperature | float(0) else 'heat') if is_number(state_attr(${literal entities.climate.airConditioner}, 'current_temperature')) else 'off' }}
  '';
}
