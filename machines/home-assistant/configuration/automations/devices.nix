{
  services.home-assistant.config.automation = [
    {
      id = "1735948041970";
      alias = "Devices / Print error notification";
      description = "Announces active printer errors. error_blacklist skips known codes: HMS_0701_2500_0002_0001 (AMS B drying without a power adapter, recurs every print), HMS_0300_A700_0003_0001 (chamber temperature high or filtration active, informational fan-speed notice).";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.balcony_h2c_hms_errors"
          ];
          from = [
            "off"
          ];
          to = [
            "on"
          ];
        }
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.balcony_h2c_print_error"
          ];
          to = [
            "on"
          ];
          from = [
            "off"
          ];
        }
      ];
      conditions = [
        {
          condition = "template";
          value_template = "{{ announcement != '' }}";
        }
      ];
      actions = [
        {
          action = "lametric.message";
          metadata = { };
          data = {
            cycles = 5;
            icon_type = "alert";
            priority = "warning";
            device_id = "73011c811d74d3602269f740ab19f003";
            message = "Print error";
            sound = "negative2";
          };
          enabled = false;
        }
        {
          action = "assist_satellite.announce";
          metadata = { };
          data = {
            message = "{{ announcement }}";
          };
          target = {
            area_id = "room";
          };
          note = "HMS text carries the actionable detail; the print error text is the fallback when no HMS code is raised.";
        }
      ];
      variables = {
        error_blacklist = [
          "HMS_0701_2500_0002_0001"
          "HMS_0300_A700_0003_0001"
        ];
        announcement = "{%- set attrs = states.binary_sensor.balcony_h2c_hms_errors.attributes | default({}, true) -%}\n{%- set ns = namespace(parts=[]) -%}\n{%- for prefix in attrs.keys() | select('search', '-Code$') | map('regex_replace', '-Code$', '') | list -%}\n  {%- if attrs[prefix ~ '-Code'] not in error_blacklist -%}\n    {%- set ns.parts = ns.parts + [attrs[prefix ~ '-Error']] -%}\n  {%- endif -%}\n{%- endfor -%}\n{%- set hms = ns.parts | join(' ') -%}\n{%- set print_code = state_attr('binary_sensor.balcony_h2c_print_error', 'code') -%}\n{%- set print_err = state_attr('binary_sensor.balcony_h2c_print_error', 'error') -%}\n{%- set print_err = print_err if print_code not in error_blacklist else none -%}\n{%- set details = hms or print_err -%}\n{{ 'Printer error. ' ~ details if details else '' }}";
      };
      mode = "single";
      initial_state = true;
    }
    {
      id = "1736031167938";
      alias = "Devices / Print finished notification";
      description = "Announces print completion and has the print_watcher AI task guess the printed object from a finished-print snapshot.";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "sensor.balcony_h2c_print_status"
          ];
          to = [
            "finish"
          ];
          from = null;
        }
      ];
      conditions = [ ];
      actions = [
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
            filename = "/media/print_finished_snapshot.jpg";
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
            task_name = "Guess the finished print";
            entity_id = "ai_task.print_watcher";
            attachments = [
              {
                media_content_id = "media-source://media_source/local/print_finished_snapshot.jpg";
                media_content_type = "image/jpeg";
              }
            ];
            instructions = "You are looking at a photo of a just-completed 3D print, taken from inside the printer's build chamber. Without being told what it is, guess what the printed object is meant to be. Answer in one short, playful sentence of plain spoken text: no markdown, no emoji, no lists. If the shape is too ambiguous or the image is too dark or blurry to judge, say that plainly instead of guessing wildly.";
          };
          response_variable = "guess";
          note = "The job name is deliberately withheld so the guess comes from the image alone.";
        }
        {
          action = "lametric.message";
          metadata = { };
          data = {
            cycles = 0;
            icon_type = "info";
            priority = "info";
            device_id = "73011c811d74d3602269f740ab19f003";
            message = "Print finished";
            sound = "positive1";
          };
          enabled = false;
        }
        {
          action = "assist_satellite.announce";
          metadata = { };
          data = {
            message = "Print finished. {{ guess.data }}";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      variables = {
        chamber_light_was_off = "{{ is_state('light.balcony_h2c_chamber_light', 'off') }}";
      };
      mode = "single";
      initial_state = true;
    }
    {
      id = "1736341453854";
      alias = "Devices / Turn on AC if settings change";
      description = "";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "climate.air_conditioner"
          ];
          attribute = "temperature";
        }
        {
          trigger = "state";
          entity_id = [
            "select.air_conditioner_vertical_swing"
          ];
          enabled = false;
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "climate.air_conditioner";
          state = "off";
          enabled = false;
        }
      ];
      actions = [
        {
          action = "climate.turn_on";
          metadata = { };
          data = { };
          target = {
            entity_id = [
              "climate.air_conditioner"
            ];
          };
        }
        {
          action = "script.set_air_conditioner_temperature";
          metadata = { };
          data = {
            target_temperature = "state_attr('climate.air_conditioner', 'temperature')";
          };
        }
      ];
      mode = "single";
      initial_state = false;
    }
    {
      id = "1739949582133";
      alias = "Devices / Zigbee router offline";
      description = "";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "binary_sensor.slzb_06p10_ethernet"
          ];
          from = "on";
          to = null;
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          metadata = { };
          data = {
            message = "The Zigbee router is offline";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1739949635477";
      alias = "Devices / Zigbee is back online";
      description = "";
      triggers = [
        {
          type = "connected";
          device_id = "4b3d15da6011e267ca6b2f7fb5e7f298";
          entity_id = "8ba67b4e6d531e0c7ec6fe5d3e692ed0";
          domain = "binary_sensor";
          trigger = "device";
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "input_boolean.homeassistant_fully_loaded";
          state = "on";
        }
      ];
      actions = [
        {
          action = "assist_satellite.announce";
          metadata = { };
          data = {
            message = "The Zigbee router is back online.";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1740515216770";
      alias = "Devices / Water leak detected";
      description = "";
      triggers = [
        {
          type = "moist";
          device_id = "bef6d5a0461276cebba9818626c6b66a";
          entity_id = "bd0d8d3c74c74417b5a1e83b834297f8";
          domain = "binary_sensor";
          trigger = "device";
        }
        {
          type = "moist";
          device_id = "20c327860fbd13c14362b00f2081b78d";
          entity_id = "947402edceac29fd393527075aba548d";
          domain = "binary_sensor";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          type = "turn_off";
          device_id = "509308a00a0dba896fe955f85dc9eaf6";
          entity_id = "48210224bde6216ebc0228fb16d2e0cd";
          domain = "switch";
        }
        {
          type = "turn_off";
          device_id = "df5c8ea1666ecfadccb338daa5cd41fb";
          entity_id = "eabe52bd0c31779fc940ef476532b0ed";
          domain = "switch";
        }
        {
          action = "assist_satellite.announce";
          metadata = { };
          data = {
            message = "Water leak detected!";
          };
          target = {
            device_id = "6711f762ca5f27d9aca0a0cfcdab92ba";
          };
        }
        {
          action = "tts.speak";
          metadata = { };
          data = {
            cache = true;
            media_player_entity_id = "media_player.all_hearing_god";
            message = "Water leak detected!";
          };
          target = {
            entity_id = "tts.elevenlabs";
          };
        }
        {
          action = "light.turn_on";
          metadata = { };
          data = {
            flash = "short";
            transition = 0;
            brightness_pct = 100;
          };
          target = {
            area_id = [
              "kitchen"
            ];
            entity_id = "light.room_overhead_lights";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1742200304139";
      alias = "Devices / Zigbee device offline notification";
      description = "";
      triggers = [
        {
          device_id = "2f71ab6f29ad7b89d7067ae6da4afe76";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
        {
          device_id = "1d6d18c0607f109486576f159ae0d7c0";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
        {
          device_id = "df5c8ea1666ecfadccb338daa5cd41fb";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
        {
          device_id = "509308a00a0dba896fe955f85dc9eaf6";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
        {
          device_id = "d7f71ba6e41eaa5f4e1673b72cac5de5";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
        {
          device_id = "57a19124691d23a75510acb5b4f70903";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
        {
          device_id = "7d75a987c8709f5ca514f1d820703461";
          domain = "zha";
          type = "device_offline";
          subtype = "device_offline";
          trigger = "device";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "assist_satellite.announce";
          metadata = { };
          data = {
            message = "{{ device_attr(trigger.device_id, name_by_user) }} is offline";
          };
          target = {
            area_id = "room";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1752329832392";
      alias = "Devices / Button Pusher helper";
      description = "";
      triggers = [
        {
          trigger = "state";
          entity_id = [
            "input_button.hoard_power"
          ];
        }
      ];
      conditions = [ ];
      actions = [
        {
          type = "turn_on";
          device_id = "c64d8e84b5baa3d5d7ded9bc8538be0e";
          entity_id = "1af18ee1a549d7d0e5dc7166054ba94d";
          domain = "switch";
        }
        {
          delay = {
            hours = 0;
            minutes = 0;
            seconds = 0;
            milliseconds = 500;
          };
          enabled = true;
        }
        {
          type = "turn_off";
          device_id = "c64d8e84b5baa3d5d7ded9bc8538be0e";
          entity_id = "1af18ee1a549d7d0e5dc7166054ba94d";
          domain = "switch";
        }
      ];
      mode = "single";
      initial_state = false;
    }
    {
      id = "1781467492529";
      alias = "Devices / Turn off Dyson Night mode";
      description = "";
      triggers = [
        {
          trigger = "time";
          at = "07:00:00";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "switch.turn_off";
          metadata = { };
          target = {
            entity_id = "switch.dyson_night_mode";
          };
          data = { };
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1790439678498";
      alias = "Devices / 3D print Live Activity";
      description = "Mirrors the H2C print on the iPhone Lock Screen / Dynamic Island as a companion-app Live Activity. Updates on status/stage changes and every 5 minutes while printing; the countdown ticks on-device via chronometer so no per-second pushes are needed (iOS throttles frequent updates).";
      triggers = [
        {
          trigger = "state";
          entity_id = "sensor.balcony_h2c_print_status";
          to = [
            "prepare"
            "running"
            "pause"
          ];
          id = "update";
        }
        {
          trigger = "state";
          entity_id = "sensor.balcony_h2c_current_stage";
          id = "update";
        }
        {
          trigger = "time_pattern";
          minutes = "/5";
          id = "update";
        }
        {
          trigger = "state";
          entity_id = "sensor.balcony_h2c_print_status";
          to = [
            "finish"
            "failed"
          ];
          id = "end";
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
            {
              condition = "state";
              entity_id = "sensor.balcony_h2c_print_status";
              state = [
                "prepare"
                "running"
                "pause"
              ];
            }
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
                    title = "H2C";
                    message = "{{ task }} · {{ 'Paused' if paused else state_translated('sensor.balcony_h2c_current_stage') }}{{ ' · layer ' ~ layer ~ '/' ~ layers if layers > 0 else '' }}";
                    data = {
                      tag = "h2c_print";
                      live_update = true;
                      progress = "{{ progress }}";
                      progress_max = 100;
                      chronometer = "{{ end_ts > 0 and not paused }}";
                      when = "{{ end_ts }}";
                      critical_text = "{{ progress }}%";
                      notification_icon = "mdi:printer-3d-nozzle";
                      notification_icon_color = "{{ '#FFB300' if paused else '#00AE42' }}";
                      silent = true;
                    };
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
                    ok = "{{ trigger.to_state.state == 'finish' }}";
                  };
                }
                {
                  action = "notify.mobile_app_iphone_15";
                  data = {
                    title = "H2C";
                    message = "{{ task }} · {{ 'Finished' if ok else 'Failed' }}";
                    data = {
                      tag = "h2c_print";
                      live_update = true;
                      progress = "{{ 100 if ok else progress }}";
                      progress_max = 100;
                      chronometer = false;
                      critical_text = "{{ 'Done' if ok else 'Failed' }}";
                      notification_icon = "{{ 'mdi:check-circle' if ok else 'mdi:alert-circle' }}";
                      notification_icon_color = "{{ '#00AE42' if ok else '#E53935' }}";
                    };
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
                    message = "clear_notification";
                    data = {
                      tag = "h2c_print";
                    };
                  };
                }
              ];
            }
          ];
        }
      ];
      variables = {
        task = "{{ states('sensor.balcony_h2c_task_name') if has_value('sensor.balcony_h2c_task_name') else 'Print' }}";
        progress = "{{ states('sensor.balcony_h2c_print_progress') | int(0) }}";
        layer = "{{ states('sensor.balcony_h2c_current_layer') | int(0) }}";
        layers = "{{ states('sensor.balcony_h2c_total_layer_count') | int(0) }}";
        end_ts = "{{ as_timestamp(states('sensor.balcony_h2c_end_time'), 0) | int }}";
        paused = "{{ is_state('sensor.balcony_h2c_print_status', 'pause') }}";
      };
      mode = "restart";
      initial_state = true;
    }
  ];
}
