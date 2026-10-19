{

  set_air_conditioner_temperature = {
    description = "Use this to set the Air Conditioner temperature. Use this instead of the Climate entity.";
    fields = {
      target_temperature = {
        selector = {
          number = {
            min = 16;
            max = 31;
            step = 1;
          };
        };
        required = true;
        description = "Desired temperature setting for the air conditioner in degrees";
        name = "Temperature";
      };
    };
    sequence = [
      {
        target = {
          entity_id = "climate.air_conditioner";
        };
        data = {
          temperature = "{{ target_temperature }}";
        };
        action = "climate.set_temperature";
      }
      {
        target = {
          entity_id = "climate.air_conditioner";
        };
        data = {
          hvac_mode = "{{ 'cool' if (state_attr('climate.air_conditioner', 'current_temperature') | float) > target_temperature else 'heat' }}\n";
        };
        action = "climate.set_hvac_mode";
        enabled = true;
      }
    ];
    alias = "Set Air Conditioner temperature";
  };
  check_print = {
    alias = "Check the 3D print";
    description = "Looks at the H2C printer's chamber camera and reports how the current print is going, with a short verdict on whether it looks healthy. Use this whenever the user asks what the print looks like, how the print or the printer is doing, or whether the print is going well. Read the returned answer back to the user as it is.";
    icon = "mdi:printer-3d-nozzle";
    mode = "single";
    variables = {
      chamber_light_was_off = "{{ is_state('light.balcony_h2c_chamber_light', 'off') }}";
      eta = "{% set t = states('sensor.balcony_h2c_end_time') | as_datetime %}{{ (t | as_local).strftime('%H:%M') if t else 'unknown' }}";
      print_error = "{{ state_attr('binary_sensor.balcony_h2c_print_error', 'error') }}";
    };
    sequence = [
      {
        alias = "Light the chamber so the snapshot is readable";
        "if" = [
          {
            condition = "state";
            entity_id = "light.balcony_h2c_chamber_light";
            state = "off";
          }
        ];
        "then" = [
          {
            action = "light.turn_on";
            target = {
              entity_id = "light.balcony_h2c_chamber_light";
            };
          }
          {
            delay = {
              seconds = 2;
            };
          }
        ];
      }
      {
        action = "camera.snapshot";
        target = {
          entity_id = "camera.balcony_h2c_camera";
        };
        data = {
          filename = "/media/print_snapshot.jpg";
        };
        note = "The media folder is the media_source root, so the file is reachable as an attachment.";
      }
      {
        alias = "Leave the chamber light as it was found";
        "if" = [
          "{{ chamber_light_was_off }}"
        ];
        "then" = [
          {
            action = "light.turn_off";
            target = {
              entity_id = "light.balcony_h2c_chamber_light";
            };
          }
        ];
      }
      {
        action = "ai_task.generate_data";
        data = {
          task_name = "Print check";
          entity_id = "ai_task.print_watcher";
          attachments = [
            {
              media_content_id = "media-source://media_source/local/print_snapshot.jpg";
              media_content_type = "image/jpeg";
            }
          ];
          instructions = "You are looking at a live camera snapshot from inside a Bambu Lab H2C 3D printer.\nPrinter reports: job \"{{ states('sensor.balcony_h2c_task_name') }}\", print status {{ states('sensor.balcony_h2c_print_status') }}, stage {{ states('sensor.balcony_h2c_current_stage') }}, {{ states('sensor.balcony_h2c_print_progress') }} percent done, layer {{ states('sensor.balcony_h2c_current_layer') }} of {{ states('sensor.balcony_h2c_total_layer_count') }}, estimated finish {{ eta }}.\n{% if print_error %}The printer is also reporting this error: {{ print_error }}.\n{% endif %}Answer in two or three short sentences of plain spoken text: no markdown, no emoji, no lists. Say what is actually visible on the build plate, whether it looks healthy (adhesion, stringing, spaghetti, warping, blobs, layer shift) or whether something looks wrong, and finish with one dry, understated joke. Quote the job name or the numbers only where they carry the answer. If the image is too dark or too blurry to judge, say that plainly instead of guessing.";
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
        stop = "Verdict ready";
        response_variable = "result";
      }
    ];
  };

}
