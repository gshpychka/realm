{
  entities,
  literal,
  mk,
  fields,
}:
{
  ollama_online = fields "boolean" "{% set models = dig(value_json | default(none), ['models']) %}{{ 'qwen3.5:9b-q8_0' in (models | select('mapping') | selectattr('name', 'defined') | map(attribute='name') | list) if models is sequence and models is not string and models is not mapping else false }}";
  gpt_ready = mk "boolean" "{{ prompt is defined and prompt is string and prompt | trim | length > 0 and (conversation_id is not defined or conversation_id is none or conversation_id is string) }}";
  gpt_request = mk "mapping" "{{ dict(text=prompt, agent_id=${literal entities.conversation.chatgptExpert}, **({'conversation_id': conversation_id} if conversation_id | default('') else {})) }}";
  gpt_conversation = fields "text" "{{ text(dig(gpt_response | default(none), ['conversation_id']), '') }}";
  gpt_speech = fields "text" "{{ text(dig(gpt_response | default(none), ['response', 'speech', 'plain', 'speech']), 'The expert response is unavailable.') }}";
}
