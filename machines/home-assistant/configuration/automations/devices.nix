{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    devices
    areas
    call
    state
    zha
    announce
    printerSnapshot
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      actions = [ (announce templates.announcement { }) ];
      alias = "Devices / Print error notification";
      conditions = [
        {
          condition = "template";
          value_template = templates.has_announcement;
        }
      ];
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
      variables = {
        announcement = templates.printer_errors;
      };
    }
    {
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
      alias = "Devices / Print finished notification";
      description = "Announces print completion and has the print_watcher AI task guess the printed object from a finished-print snapshot.";
      triggers = [
        {
          entity_id = [ entities.sensor.balconyH2CPrintStatus ];
          to = [ "finish" ];
          trigger = "state";
        }
      ];
      variables = {
        chamber_light_was_off = templates.chamber_was_off;
      };
    }
    {
      actions = [ (announce "The Zigbee router is offline" { }) ];
      alias = "Devices / Zigbee router offline";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.slzb06P10Ethernet ];
          from = "on";
          trigger = "state";
        }
      ];
    }
    {
      actions = [ (announce "The Zigbee router is back online." { }) ];
      alias = "Devices / Zigbee is back online";
      conditions = [ (state entities.input_boolean.fullyLoaded "on") ];
      triggers = [
        {
          trigger = "state";
          entity_id = entities.binary_sensor.slzb06P10Ethernet;
          to = "on";
        }
      ];
    }
    {
      actions = [
        (call "switch.turn_off" entities.switch.hotWaterValve { })
        (call "switch.turn_off" entities.switch.coldWaterValve { })
        {
          action = "assist_satellite.announce";
          data = {
            message = "Water leak detected!";
          };
          target = {
            device_id = devices.roomVoiceTarget;
          };
        }
        (call "tts.speak" entities.tts.elevenlabs {
          cache = true;
          media_player_entity_id = entities.media_player.allHearingGod;
          message = "Water leak detected!";
        })
        {
          action = "light.turn_on";
          data = {
            brightness_pct = 100;
            flash = "short";
            transition = 0;
          };
          target = {
            area_id = areas.kitchen;
            entity_id = entities.light.roomOverheadLights;
          };
        }
      ];
      alias = "Devices / Water leak detected";
      triggers = [
        {
          trigger = "state";
          entity_id = entities.binary_sensor.leakSensorAMoisture;
          to = "on";
        }
        {
          trigger = "state";
          entity_id = entities.binary_sensor.leakSensorBMoisture;
          to = "on";
        }
      ];
    }
    {
      actions = [
        (announce templates.device_offline { })
      ];
      alias = "Devices / Zigbee device offline notification";
      triggers = [
        (zha devices.bedButton "device_offline" "device_offline")
        (zha devices.bedShelfButton "device_offline" "device_offline")
        (zha devices.coldWaterValve "device_offline" "device_offline")
        (zha devices.hotWaterValve "device_offline" "device_offline")
        (zha devices.roomLightswitch "device_offline" "device_offline")
        (zha devices.kitchenLightswitch "device_offline" "device_offline")
        (zha devices.kitchenTableButton "device_offline" "device_offline")
      ];
    }
    {
      actions = [ (call "switch.turn_off" entities.switch.dysonNightMode { }) ];
      alias = "Devices / Turn off Dyson Night mode";
      triggers = [
        {
          at = "07:00:00";
          trigger = "time";
        }
      ];
    }
    {
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
      alias = "Devices / 3D print Live Activity";
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
      description = "Mirrors the H2C print on the iPhone Lock Screen / Dynamic Island as a companion-app Live Activity. Updates on status/stage changes and every 5 minutes while printing; the countdown ticks on-device via chronometer so no per-second pushes are needed (iOS throttles frequent updates).";
      mode = "restart";
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
      variables = {
        inherit (templates) end_ts;
        inherit (templates) layer;
        inherit (templates) layers;
        inherit (templates) paused;
        inherit (templates) progress;
        inherit (templates) task;
      };
    }
  ];
}
