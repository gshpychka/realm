{ ha, ... }:
let
  inherit (ha)
    templates
    ;
in
{
  services.home-assistant.config.script = builtins.mapAttrs (_: ha.script) {
    ask_gpt = {
      alias = "Talk to GPT";
      description = ''
        You can use this to ask an advanced GPT model for assistance with harder questions, especially when the users asks the assistant to "Ask GPT" or "Tell GPT".
        When the user wants to make repeated subsequent requests to GPT, make sure to use the returned `conversation_id` parameter to keep the same conversation going.'';
      fields = {
        conversation_id = {
          description = "The ID of a previous conversation to continue. Pass the conversation_id from a previous response to continue a previous conversation, retaining all prompt history and context";
          name = "Conversation ID";
          selector = {
            text = { };
          };
        };
        prompt = {
          description = "The query prompt to pass on to the expert model. Set this to the full question or prompt with all the required context";
          name = "Prompt";
          required = true;
          selector = {
            text = { };
          };
        };
      };
      max = 3;
      mode = "parallel";
      sequence = [
        {
          condition = "template";
          value_template = templates.gpt_ready;
        }
        {
          action = "conversation.process";
          data = templates.gpt_request;
          response_variable = "gpt_response";
        }
        {
          variables = {
            result = {
              conversation_id = templates.gpt_conversation;
              instructions = "Make sure to say that you got the response from GPT. Preface the answer with \"Here's what GPT said: \". Use the returned conversation_id in subsequent calls to continue this conversation.";
              response = templates.gpt_speech;
            };
          };
        }
        {
          response_variable = "result";
          stop = "Complete";
        }
      ];
    };
  };
}
