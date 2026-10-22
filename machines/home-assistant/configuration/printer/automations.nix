{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    state
    announce
    printerSnapshot
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      id = "1735948041970";
      alias = "Devices / Print error notification";
      description = "Announces actionable printer errors, suppressing known informational HMS codes.";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.balconyH2CHmsErrors ];
          from = [ "off" ];
          to = [ "on" ];
          trigger = "state";
        }
        {
          entity_id = [ entities.binary_sensor.balconyH2CPrintError ];
          from = [ "off" ];
          to = [ "on" ];
          trigger = "state";
        }
      ];
      conditions = [
        {
          condition = "template";
          value_template = templates.has_announcement;
        }
      ];
      actions = [ (announce templates.announcement { }) ];
      variables = {
        announcement = templates.printer_errors;
      };
    }
    {
      id = "1736031167938";
      alias = "Devices / Print finished notification";
      description = "Announces print completion and has the print_watcher AI task guess the printed object from a finished-print snapshot.";
      triggers = [
        {
          entity_id = [ entities.sensor.balconyH2CPrintStatus ];
          to = [ "finish" ];
          trigger = "state";
        }
      ];
      actions = printerSnapshot "print_finished_snapshot.jpg" ++ [
        {
          action = "ai_task.generate_data";
          data = {
            attachments = [
              {
                media_content_id = "media-source://media_source/local/print_finished_snapshot.jpg";
                media_content_type = "image/jpeg";
              }
            ];
            entity_id = entities.ai_task.printWatcher;
            instructions = "You are looking at a photo of a just-completed 3D print, taken from inside the printer's build chamber. Without being told what it is, guess what the printed object is meant to be. Answer in one short, playful sentence of plain spoken text: no markdown, no emoji, no lists. If the shape is too ambiguous or the image is too dark or blurry to judge, say that plainly instead of guessing wildly.";
            task_name = "Guess the finished print";
          };
          response_variable = "guess";
        }
        (announce templates.print_finished { })
      ];
      variables = {
        chamber_light_was_off = templates.chamber_was_off;
      };
    }
    {
      id = "1790439678498";
      alias = "Devices / 3D print Live Activity";
      description = "Mirrors the H2C print on the iPhone Lock Screen / Dynamic Island as a companion-app Live Activity. Updates on status/stage changes and every 5 minutes while printing; the countdown ticks on-device via chronometer so no per-second pushes are needed (iOS throttles frequent updates).";
      triggers = [
        {
          entity_id = entities.sensor.balconyH2CPrintStatus;
          id = "update";
          to = [
            "prepare"
            "running"
            "pause"
          ];
          trigger = "state";
        }
        {
          entity_id = entities.sensor.balconyH2CCurrentStage;
          id = "update";
          trigger = "state";
        }
        {
          id = "update";
          minutes = "/5";
          trigger = "time_pattern";
        }
        {
          entity_id = entities.sensor.balconyH2CPrintStatus;
          id = "end";
          to = [
            "finish"
            "failed"
          ];
          trigger = "state";
        }
      ];
      conditions = [
        {
          condition = "or";
          conditions = [
            {
              condition = "trigger";
              id = "end";
            }
            (state entities.sensor.balconyH2CPrintStatus [
              "prepare"
              "running"
              "pause"
            ])
          ];
        }
      ];
      actions = [
        {
          choose = [
            {
              conditions = [
                {
                  condition = "trigger";
                  id = "update";
                }
              ];
              sequence = [
                {
                  action = "notify.mobile_app_iphone_15";
                  data = {
                    data = {
                      chronometer = templates.print_chronometer;
                      critical_text = templates.print_percent;
                      live_update = true;
                      notification_icon = "mdi:printer-3d-nozzle";
                      notification_icon_color = templates.print_color;
                      progress = templates.print_progress;
                      progress_max = 100;
                      silent = true;
                      tag = "h2c_print";
                      when = templates.print_when;
                    };
                    message = templates.print_status;
                    title = "H2C";
                  };
                }
              ];
            }
            {
              conditions = [
                {
                  condition = "trigger";
                  id = "end";
                }
              ];
              sequence = [
                {
                  variables = {
                    ok = templates.print_ok;
                  };
                }
                {
                  action = "notify.mobile_app_iphone_15";
                  data = {
                    data = {
                      chronometer = false;
                      critical_text = templates.print_final_text;
                      live_update = true;
                      notification_icon = templates.print_final_icon;
                      notification_icon_color = templates.print_final_color;
                      progress = templates.print_final_progress;
                      progress_max = 100;
                      tag = "h2c_print";
                    };
                    message = templates.print_final_status;
                    title = "H2C";
                  };
                }
                {
                  alias = "Keep the final state visible for a while, then end the activity";
                  delay = {
                    minutes = 30;
                  };
                }
                {
                  action = "notify.mobile_app_iphone_15";
                  data = {
                    data = {
                      tag = "h2c_print";
                    };
                    message = "clear_notification";
                  };
                }
              ];
            }
          ];
        }
      ];
      variables = {
        inherit (templates) end_ts;
        inherit (templates) layer;
        inherit (templates) layers;
        inherit (templates) paused;
        inherit (templates) progress;
        inherit (templates) task;
      };
      mode = "restart";
    }
    {
      id = "1787590347448";
      alias = "Voice / Print check by voice";
      description = "Answers spoken questions about the running print with a camera-based verdict.";
      triggers = [
        {
          command = [
            "(how's|how is) [the|my] print (going|looking|doing)"
            "how does [the|my] print look"
            "what does [the|my] print look like"
            "check [on] [the|my] print"
            "(how's|how is) [the] printer doing"
            "look at [the|my] print"
            "(how's|how is) [the|my] print"
            "(what's|what is) [the|my] print doing"
            "is [the|my] print (ok|okay|alright|fine|going well)"
          ];
          trigger = "conversation";
        }
      ];
      actions = [
        {
          action = "script.check_print";
          response_variable = "verdict";
        }
        { set_conversation_response = templates.print_answer; }
      ];
      max_exceeded = "silent";
    }
  ];
}
