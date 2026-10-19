{
  entities,
  literal,
  mk,
  fields,
}:
let
  ignoredPrinterErrors = [
    "HMS_0701_2500_0002_0001" # AMS B drying without a power adapter
    "HMS_0300_A700_0003_0001" # Informational chamber/filtration fan notice
  ];
in
{
  printer_errors = mk "text" ''
    {%- set error_blacklist = ${literal ignoredPrinterErrors} -%}
    {%- set entity = states[${literal entities.binary_sensor.balconyH2CHmsErrors}] -%}
    {%- set attrs = entity.attributes if entity is not none else {} -%}
    {%- set ns = namespace(parts=[]) -%}
    {%- for prefix in attrs.keys() | select('search', '-Code$') | map('regex_replace', '-Code$', ''') | list -%}
      {%- if attrs[prefix ~ '-Code'] not in error_blacklist and attrs.get(prefix ~ '-Error') -%}
        {%- set ns.parts = ns.parts + [attrs[prefix ~ '-Error']] -%}
      {%- endif -%}
    {%- endfor -%}
    {%- set hms = ns.parts | join(' ') -%}
    {%- set print_code = state_attr(${literal entities.binary_sensor.balconyH2CPrintError}, 'code') -%}
    {%- set print_err = state_attr(${literal entities.binary_sensor.balconyH2CPrintError}, 'error') -%}
    {%- set print_err = print_err if print_code not in error_blacklist else none -%}
    {%- set details = hms or print_err -%}
    {{ 'Printer error. ' ~ details if details else ''' }}'';
  restore_chamber = mk "boolean" "{{ chamber_light_was_off }}";
  print_finished = fields "text" "Print finished. {{ text(dig(guess | default(none), ['data']), 'The image could not be assessed.') }}";
  chamber_was_off = mk "boolean" "{{ is_state(${literal entities.light.balconyH2CChamberLight}, 'off') }}";
  print_chronometer = mk "boolean" "{{ end_ts > 0 and not paused }}";
  print_percent = mk "text" "{{ progress }}%";
  print_color = mk "text" "{{ '#FFB300' if paused else '#00AE42' }}";
  print_progress = mk "integer" "{{ progress }}";
  print_when = mk "integer" "{{ end_ts }}";
  print_status = mk "text" "{{ task }} · {{ 'Paused' if paused else state_translated(${literal entities.sensor.balconyH2CCurrentStage}) }}{{ ' · layer ' ~ layer ~ '/' ~ layers if layers > 0 else '' }}";
  print_ok = fields "boolean" "{{ dig(trigger | default(none), ['to_state', 'state']) == 'finish' }}";
  print_final_text = mk "text" "{{ 'Done' if ok else 'Failed' }}";
  print_final_icon = mk "text" "{{ 'mdi:check-circle' if ok else 'mdi:alert-circle' }}";
  print_final_color = mk "text" "{{ '#00AE42' if ok else '#E53935' }}";
  print_final_progress = mk "integer" "{{ 100 if ok else progress }}";
  print_final_status = mk "text" "{{ task }} · {{ 'Finished' if ok else 'Failed' }}";
  end_ts = mk "integer" "{{ as_timestamp(states(${literal entities.sensor.balconyH2CEndTime}), 0) | int }}";
  layer = mk "integer" "{{ states(${literal entities.sensor.balconyH2CCurrentLayer}) | int(0) }}";
  layers = mk "integer" "{{ states(${literal entities.sensor.balconyH2CTotalLayerCount}) | int(0) }}";
  paused = mk "boolean" "{{ is_state(${literal entities.sensor.balconyH2CPrintStatus}, 'pause') }}";
  progress = mk "integer" "{{ states(${literal entities.sensor.balconyH2CPrintProgress}) | int(0) }}";
  task = mk "text" "{{ states(${literal entities.sensor.balconyH2CTaskName}) if has_value(${literal entities.sensor.balconyH2CTaskName}) else 'Print' }}";
  print_answer = fields "text" "{{ text(dig(verdict | default(none), ['answer']), 'The print could not be assessed.') }}";
  print_prompt = mk "text" ''
    You are looking at a live camera snapshot from inside a Bambu Lab H2C 3D printer.
    Printer reports: job "{{ states(${literal entities.sensor.balconyH2CTaskName}) }}", print status {{ states(${literal entities.sensor.balconyH2CPrintStatus}) }}, stage {{ states(${literal entities.sensor.balconyH2CCurrentStage}) }}, {{ states(${literal entities.sensor.balconyH2CPrintProgress}) }} percent done, layer {{ states(${literal entities.sensor.balconyH2CCurrentLayer}) }} of {{ states(${literal entities.sensor.balconyH2CTotalLayerCount}) }}, estimated finish {{ eta }}.
    {% if print_error %}The printer is also reporting this error: {{ print_error }}.
    {% endif %}Answer in two or three short sentences of plain spoken text: no markdown, no emoji, no lists. Say what is actually visible on the build plate, whether it looks healthy (adhesion, stringing, spaghetti, warping, blobs, layer shift) or whether something looks wrong, and finish with one dry, understated joke. Quote the job name or the numbers only where they carry the answer. If the image is too dark or too blurry to judge, say that plainly instead of guessing.'';
  print_verdict = fields "text" "{{ text(dig(verdict | default(none), ['data']), 'The print could not be assessed.') }}";
  print_eta = mk "text" "{% set t = states(${literal entities.sensor.balconyH2CEndTime}) | as_datetime(none) %}{{ (t | as_local).strftime('%H:%M') if t else 'unknown' }}";
  print_error = mk "nullable-text" "{% set err = state_attr(${literal entities.binary_sensor.balconyH2CPrintError}, 'error') %}{{ err if err is string else none }}";
}
