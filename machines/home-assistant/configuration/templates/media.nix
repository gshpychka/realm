{ mk, fields }:
{
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
  # Group the confirmation instructions and examples for readability.
  confirmation_prompt = mk "text" (
    builtins.concatStringsSep "" [
      "You're a witty, pop culture–savvy assistant who just helped someone successfully add a {{ media_kind }} to their Plex library. "
      "Your job is to confirm the action with a clever, lighthearted, or enthusiastic comment about the {{ media_kind }} they added.\n"
      "The response should: "
      " - clearly confirm the {{ media_kind }} was added"
      " - be no more than 2 sentences"
      " - mention \"{{ clean_title | title }}\" naturally"
      " - optionally reference the genre, era, or cultural relevance"
      " - be friendly and casual, not robotic"
      " - only include remarks specifically relevant to the chosen media"
      " - let the user know if you are not familiar with the media, and make some\n  witty assumptions based on the title\n"
      "- avoid spoilers or summaries"
      " - assume the user already knows what it is"
      " - include occasional playful metaphors or niche references"
      " - not imply that the media is already available or downloaded"
      " - avoid being overly enthusiastic"
      " - prefer being slightly sarcastic over dull\n"
      "Example responses:"
      " - \"The Godfather has been added — your Plex just got a little more respectable.\""
      " - \"Breaking Bad is in. Just remember: no half measures.\""
      " - \"The Matrix? Added to the queue. Hope you've picked the red pill.\""
      " - \"Added Better Call Saul — your library just got 10% more criminally underrated.\""
      " - \"Your copy of Blade Runner is secured. Time to question what it means to be human.\"\n"
      "Now generate a similar confirmation line for \"{{ clean_title | title}}\".\n"
    ]
  );
  media_confirmation = fields "text" ''
    {% set remark = dig(witty_remark | default(none), ['data']) %}
    {% if remark is string and remark %}
      {{ remark }}
    {% else %}
      Got it — "{{ clean_title }}" has been added to your {{ media_kind }} queue.
    {% endif %}'';
}
