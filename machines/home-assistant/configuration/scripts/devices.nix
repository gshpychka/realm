{ ha }:
let
  inherit (ha) entities call printerSnapshot;
in
{
  set_air_conditioner_temperature = {
    alias = "Set Air Conditioner temperature";
    description = "Use this to set the Air Conditioner temperature. Use this instead of the Climate entity.";
    fields = {
      target_temperature = {
        description = "Desired temperature setting for the air conditioner in degrees";
        name = "Temperature";
        required = true;
        selector = {
          number = {
            max = 31;
            min = 16;
            step = 1;
          };
        };
      };
    };
    sequence = [
      (call "climate.set_temperature" entities.climate.airConditioner {
        temperature = "{{ target_temperature }}";
      })
      (call "climate.set_hvac_mode" entities.climate.airConditioner {
        hvac_mode = ''
          {{ 'cool' if (state_attr('${entities.climate.airConditioner}', 'current_temperature') | float) > target_temperature else 'heat' }}
        '';
      })
    ];
  };
  check_print = {
    alias = "Check the 3D print";
    description = "Looks at the H2C printer's chamber camera and reports how the current print is going, with a short verdict on whether it looks healthy. Use this whenever the user asks what the print looks like, how the print or the printer is doing, or whether the print is going well. Read the returned answer back to the user as it is.";
    icon = "mdi:printer-3d-nozzle";
    sequence = (
      printerSnapshot "print_snapshot.jpg"
      ++ [
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
            instructions = ''
              You are looking at a live camera snapshot from inside a Bambu Lab H2C 3D printer.
              Printer reports: job "{{ states('${entities.sensor.balconyH2CTaskName}') }}", print status {{ states('${entities.sensor.balconyH2CPrintStatus}') }}, stage {{ states('${entities.sensor.balconyH2CCurrentStage}') }}, {{ states('${entities.sensor.balconyH2CPrintProgress}') }} percent done, layer {{ states('${entities.sensor.balconyH2CCurrentLayer}') }} of {{ states('${entities.sensor.balconyH2CTotalLayerCount}') }}, estimated finish {{ eta }}.
              {% if print_error %}The printer is also reporting this error: {{ print_error }}.
              {% endif %}Answer in two or three short sentences of plain spoken text: no markdown, no emoji, no lists. Say what is actually visible on the build plate, whether it looks healthy (adhesion, stringing, spaghetti, warping, blobs, layer shift) or whether something looks wrong, and finish with one dry, understated joke. Quote the job name or the numbers only where they carry the answer. If the image is too dark or too blurry to judge, say that plainly instead of guessing.'';
            task_name = "Print check";
          };
          response_variable = "verdict";
        }
        {
          variables = {
            result = {
              answer = "{{ verdict.data }}";
            };
          };
        }
        {
          response_variable = "result";
          stop = "Verdict ready";
        }
      ]
    );
    variables = {
      chamber_light_was_off = "{{ is_state('${entities.light.balconyH2CChamberLight}', 'off') }}";
      eta = "{% set t = states('${entities.sensor.balconyH2CEndTime}') | as_datetime %}{{ (t | as_local).strftime('%H:%M') if t else 'unknown' }}";
      print_error = "{{ state_attr('${entities.binary_sensor.balconyH2CPrintError}', 'error') }}";
    };
  };
}
