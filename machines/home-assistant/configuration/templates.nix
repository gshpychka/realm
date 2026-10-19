# Template programs are centralized here; lib.nix only exposes their checked
# sources. The pinned HA compiler, strict renders, scope audit and fixtures run
# in home-assistant-config and in the host's build dependency. These contracts
# describe tested results, not static proofs of arbitrary Jinja programs.
let
  entities = import ./entities.nix;
  literal = import ./template-literal.nix;
  ignoredPrinterErrors = [
    "HMS_0701_2500_0002_0001" # AMS B drying without a power adapter
    "HMS_0300_A700_0003_0001" # Informational chamber/filtration fan notice
  ];
  mk =
    output: source:
    assert builtins.elem output [
      "text"
      "boolean"
      "integer"
      "number"
      "list"
      "mapping"
      "nullable-text"
      "number-or-unknown"
    ];
    assert builtins.isString source;
    {
      inherit output source;
    };
  fields = output: source: mk output ((builtins.readFile ./safe-fields.jinja) + source);
in
{
  announcement = mk "text" "{{ announcement }}";
  has_announcement = mk "boolean" "{{ announcement != '' }}";
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
  device_offline = fields "text" "{% set device = dig(trigger | default(none), ['event', 'data', 'device_id']) %}{{ (device_attr(device, 'name_by_user') or device_attr(device, 'name') or 'Zigbee device') if device else 'Zigbee device' }} is offline";
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
  message = mk "text" "{{ message }}";
  battery_low = mk "text" "Warning: The battery level is - {{states(${literal entities.sensor.batteryCharge}) | int('unknown') }}  percent...";
  battery_time_low = mk "text" "Warning: Less than one hour of battery power remaining. Battery is at {{ (states(${literal entities.sensor.batteryCharge}) | float | round(0)) if is_number(states(${literal entities.sensor.batteryCharge})) else 'unknown' }} percent.";
  city_power_on = mk "text" "Power is back on. Battery is at {{states(${literal entities.sensor.batteryCharge}) | int('unknown') }} percent.";
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
    {% set ns = namespace(t=''') %} {# current #} {% if is_number(state_attr(${literal entities.weather.openweathermap}, 'temperature')) %}{% set ns.t = ns.t ~ "It's " ~ (now_temp | round(0)) ~ " degrees and " ~ now_cond ~ ". " %}{% else %}{% set ns.t = 'Current weather information is unavailable. ' %}{% endif %} {% if diff > 2 %}
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
  provider_changed = mk "text" "Internet provider changed to {{states(${literal entities.sensor.internetProvider})}}";
  slots = mk "mapping" "{{ trigger.slots if trigger is defined and trigger.slots is defined and trigger.slots is mapping else {} }}";
  raw_title = mk "text" "{{ ((slots.get('movie_title') or slots.get('show_title') or slots.get('title') or '') | string) | regex_replace(' +(on|to|in|into|2) +((my|our|the) +)?(media +)?((plex|duplex)( +(library|collection))?|library|collection|watch ?list)( +please)?$', '', ignorecase=True) | regex_replace(' +please$', '', ignorecase=True) | trim }}";
  raw_type = mk "text" "{{ 'movie' if slots.get('movie_title') else 'show' if slots.get('show_title') else ((slots.get('media_type') or '') | string | lower | trim) }}";
  media_kind = mk "text" ''
    {%- set title = raw_title | string -%}
    {%- set first = (title.split(' ', 1)[0] if title else ''') | lower -%}
    {%- if raw_type in ['movie', 'film'] -%} movie
    {%- elif raw_type in ['show', 'series', 'tv', 'tv show', 'tv series'] -%} show
    {%- elif first in ['movie', 'film'] -%} movie
    {%- elif first in ['show', 'series', 'tv', 'television'] -%} show
    {%- else -%} unknown
    {%- endif -%}'';
  clean_title = mk "text" ''
    {%- if raw_type == ''' and media_kind in ['movie', 'show'] -%}
    {{ raw_title | string | regex_replace('^(movie|film|tv show|tv series|television show|television series|show|series|tv) +', ''', ignorecase=True) }}
    {%- else -%}{{ raw_title | string }}{%- endif -%}'';
  reject_media = mk "boolean" "{%- set t = (raw_title | string | lower | trim) -%}{{ t == '' or (t is search('(^| )(to|on|in|into|onto|2) (the|my|our|this) ([^ ]+ )*(list|lists|calendar|reminders?|agenda|notes|schedule|cart|basket|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)$')) or (t is search('(^| )(to|on|for) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow)$')) or (t is search('(^| )(shopping|grocery|groceries|to-do|todo) list( |$)')) }}";
  unknown_media = mk "boolean" "{{ media_kind == 'unknown' }}";
  classifier_prompt = mk "text" "You are a classifier. Reply with **exactly one word**: \"movie\" if \"{{ clean_title }}\" is primarily a feature film, \"show\"  if it is primarily a television/streaming series, otherwise \"unknown\". No punctuation. No extra words.";
  classified_media = fields "text" ''
    {% set kind = (dig(llm_kind | default(none), ['response', 'speech', 'plain', 'speech']) or ''') | string | lower %} {{ 'movie' if kind == 'movie'
       else 'show' if kind == 'show'
       else 'unknown' }}
  '';
  unsure_media = mk "text" "Sorry, I'm not sure if {{ clean_title }} is a movie or a show.. Try saying, \"Add the movie {{ clean_title }} to my library\".";
  movie_media = mk "boolean" "{{ media_kind == 'movie' }}";
  title_case = mk "text" "{{ clean_title | title }}";
  show_media = mk "boolean" "{{ media_kind == 'show' }}";
  confirmation_prompt = mk "text" ''
    You're a witty, pop culture–savvy assistant who just helped someone successfully add a {{ media_kind }} to their Plex library. Your job is to confirm the action with a clever, lighthearted, or enthusiastic comment about the {{ media_kind }} they added.
    The response should:  - clearly confirm the {{ media_kind }} was added - be no more than 2 sentences - mention "{{ clean_title | title }}" naturally - optionally reference the genre, era, or cultural relevance - be friendly and casual, not robotic - only include remarks specifically relevant to the chosen media - let the user know if you are not familiar with the media, and make some
      witty assumptions based on the title
    - avoid spoilers or summaries - assume the user already knows what it is - include occasional playful metaphors or niche references - not imply that the media is already available or downloaded - avoid being overly enthusiastic - prefer being slightly sarcastic over dull
    Example responses: - "The Godfather has been added — your Plex just got a little more respectable." - "Breaking Bad is in. Just remember: no half measures." - "The Matrix? Added to the queue. Hope you've picked the red pill." - "Added Better Call Saul — your library just got 10% more criminally underrated." - "Your copy of Blade Runner is secured. Time to question what it means to be human."
    Now generate a similar confirmation line for "{{ clean_title | title}}".
  '';
  media_confirmation = fields "text" ''
    {% set remark = dig(witty_remark | default(none), ['data']) %}
    {% if remark is string and remark %}
      {{ remark }}
    {% else %}
      Got it — "{{ clean_title }}" has been added to your {{ media_kind }} queue.
    {% endif %}'';
  battery_level = mk "text" "Battery is at {{states(${literal entities.sensor.batteryCharge})}} percent.";
  power_alarm = fields "text" ''
    Attention - alarm triggered: {{ dig(trigger | default(none), ['to_state', 'attributes', 'friendly_name']) | default('Power system', true) }}
  '';
  print_answer = fields "text" "{{ text(dig(verdict | default(none), ['answer']), 'The print could not be assessed.') }}";
  ollama_online = fields "boolean" "{% set models = dig(value_json | default(none), ['models']) %}{{ 'qwen3.5:9b-q8_0' in (models | select('mapping') | selectattr('name', 'defined') | map(attribute='name') | list) if models is sequence and models is not string and models is not mapping else false }}";
  fan_speed = mk "number-or-unknown" "{% set parts = (value | default('') | string).split() %}{{ parts[0] | int if parts and is_number(parts[0]) and 0 <= parts[0] | float <= 100 else 'unknown' }}";
  gpt_ready = mk "boolean" "{{ prompt is defined and prompt is string and prompt | trim | length > 0 and (conversation_id is not defined or conversation_id is string) }}";
  gpt_request = mk "mapping" "{{ dict(text=prompt, agent_id=${literal entities.conversation.chatgptExpert}, **({'conversation_id': conversation_id} if conversation_id | default('') else {})) }}";
  gpt_conversation = fields "text" "{{ text(dig(gpt_response | default(none), ['conversation_id']), '') }}";
  gpt_speech = fields "text" "{{ text(dig(gpt_response | default(none), ['response', 'speech', 'plain', 'speech']), 'The expert response is unavailable.') }}";
  print_prompt = mk "text" ''
    You are looking at a live camera snapshot from inside a Bambu Lab H2C 3D printer.
    Printer reports: job "{{ states(${literal entities.sensor.balconyH2CTaskName}) }}", print status {{ states(${literal entities.sensor.balconyH2CPrintStatus}) }}, stage {{ states(${literal entities.sensor.balconyH2CCurrentStage}) }}, {{ states(${literal entities.sensor.balconyH2CPrintProgress}) }} percent done, layer {{ states(${literal entities.sensor.balconyH2CCurrentLayer}) }} of {{ states(${literal entities.sensor.balconyH2CTotalLayerCount}) }}, estimated finish {{ eta }}.
    {% if print_error %}The printer is also reporting this error: {{ print_error }}.
    {% endif %}Answer in two or three short sentences of plain spoken text: no markdown, no emoji, no lists. Say what is actually visible on the build plate, whether it looks healthy (adhesion, stringing, spaghetti, warping, blobs, layer shift) or whether something looks wrong, and finish with one dry, understated joke. Quote the job name or the numbers only where they carry the answer. If the image is too dark or too blurry to judge, say that plainly instead of guessing.'';
  print_verdict = fields "text" "{{ text(dig(verdict | default(none), ['data']), 'The print could not be assessed.') }}";
  print_eta = mk "text" "{% set t = states(${literal entities.sensor.balconyH2CEndTime}) | as_datetime(none) %}{{ (t | as_local).strftime('%H:%M') if t else 'unknown' }}";
  print_error = mk "nullable-text" "{% set err = state_attr(${literal entities.binary_sensor.balconyH2CPrintError}, 'error') %}{{ err if err is string else none }}";
  ac_ready = mk "boolean" "{{ target_temperature is defined and target_temperature is number and target_temperature is not boolean and 16 <= target_temperature <= 31 and is_number(state_attr(${literal entities.climate.airConditioner}, 'current_temperature')) }}";
  target_temperature = mk "number" "{{ target_temperature | float(0) }}";
  hvac_mode = mk "text" ''
    {{ ('cool' if (state_attr(${literal entities.climate.airConditioner}, 'current_temperature') | float(0)) > target_temperature | float(0) else 'heat') if is_number(state_attr(${literal entities.climate.airConditioner}, 'current_temperature')) else 'off' }}
  '';
}
