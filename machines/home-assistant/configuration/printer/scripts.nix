{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    printerSnapshot
    ;
in
{
  services.home-assistant.config.script = builtins.mapAttrs (_: ha.script) {
    check_print = {
      alias = "Check the 3D print";
      description = "Looks at the H2C printer's chamber camera and reports how the current print is going, with a short verdict on whether it looks healthy. Use this whenever the user asks what the print looks like, how the print or the printer is doing, or whether the print is going well. Read the returned answer back to the user as it is.";
      icon = "mdi:printer-3d-nozzle";
      sequence = printerSnapshot "print_snapshot.jpg" ++ [
        {
          action = "ai_task.generate_data";
          data = {
            attachments = [
              {
                media_content_id = "media-source://media_source/local/print_snapshot.jpg";
                media_content_type = "image/jpeg";
              }
            ];
            entity_id = entities.ai_task.printWatcher;
            instructions = templates.print_prompt;
            task_name = "Print check";
          };
          response_variable = "verdict";
        }
        {
          variables = {
            result = {
              answer = templates.print_verdict;
            };
          };
        }
        {
          response_variable = "result";
          stop = "Verdict ready";
        }
      ];
      variables = {
        chamber_light_was_off = templates.chamber_was_off;
        eta = templates.print_eta;
        inherit (templates) print_error;
      };
    };
  };
}
