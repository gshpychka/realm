{ entities }:
{
  ollama_online = {
    output = "boolean";
    file = "gpt/ollama-online.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  gpt_ready = {
    output = "boolean";
    file = "gpt/gpt-ready.jinja";
  };
  gpt_request = {
    output = "mapping";
    file = "gpt/gpt-request.jinja";
    bindings = {
      CHATGPT_EXPERT = entities.conversation.chatgptExpert;
    };
  };
  gpt_conversation = {
    output = "text";
    file = "gpt/gpt-conversation.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
  gpt_speech = {
    output = "text";
    file = "gpt/gpt-speech.jinja";
    helpers = [ "shared/safe-fields.jinja" ];
  };
}
