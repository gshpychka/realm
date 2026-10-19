{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    areas
    automation
    call
    state
    zha
    announce
    printerSnapshot
    ;
  ignoredPrinterErrors = [
    "HMS_0701_2500_0002_0001" # AMS B drying without a power adapter
    "HMS_0300_A700_0003_0001" # Informational chamber/filtration fan notice
  ];
in
{
  services.home-assistant.config.automation = [
    (automation "devices_print_error_notification" {
      actions = [ (announce "{{ announcement }}" { }) ];
      alias = "Devices / Print error notification";
      conditions = [
        {
          condition = "template";
          value_template = "{{ announcement != '' }}";
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
        announcement = ''
          {%- set error_blacklist = ${builtins.toJSON ignoredPrinterErrors} -%}
          {%- set attrs = states.${entities.binary_sensor.balconyH2CHmsErrors}.attributes | default({}, true) -%}
          {%- set ns = namespace(parts=[]) -%}
          {%- for prefix in attrs.keys() | select('search', '-Code$') | map('regex_replace', '-Code$', ''') | list -%}
            {%- if attrs[prefix ~ '-Code'] not in error_blacklist -%}
              {%- set ns.parts = ns.parts + [attrs[prefix ~ '-Error']] -%}
            {%- endif -%}
          {%- endfor -%}
          {%- set hms = ns.parts | join(' ') -%}
          {%- set print_code = state_attr('${entities.binary_sensor.balconyH2CPrintError}', 'code') -%}
          {%- set print_err = state_attr('${entities.binary_sensor.balconyH2CPrintError}', 'error') -%}
          {%- set print_err = print_err if print_code not in error_blacklist else none -%}
          {%- set details = hms or print_err -%}
          {{ 'Printer error. ' ~ details if details else ''' }}'';
      };
    })
    (automation "devices_print_finished_notification" {
      actions = (
        printerSnapshot "print_finished_snapshot.jpg"
        ++ [
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
          (announce "Print finished. {{ guess.data }}" { })
        ]
      );
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
        chamber_light_was_off = "{{ is_state('${entities.light.balconyH2CChamberLight}', 'off') }}";
      };
    })
    (automation "devices_zigbee_router_offline" {
      actions = [ (announce "The Zigbee router is offline" { }) ];
      alias = "Devices / Zigbee router offline";
      triggers = [
        {
          entity_id = [ entities.binary_sensor.slzb06P10Ethernet ];
          from = "on";
          trigger = "state";
        }
      ];
    })
    (automation "devices_zigbee_is_back_online" {
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
    })
    (automation "devices_water_leak_detected" {
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
    })
    (automation "devices_zigbee_device_offline_notification" {
      actions = [
        (announce
          "{{ device_attr(trigger.event.data.device_id, 'name_by_user') or device_attr(trigger.event.data.device_id, 'name') }} is offline"
          { }
        )
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
    })
    (automation "devices_turn_off_dyson_night_mode" {
      actions = [ (call "switch.turn_off" entities.switch.dysonNightMode { }) ];
      alias = "Devices / Turn off Dyson Night mode";
      triggers = [
        {
          at = "07:00:00";
          trigger = "time";
        }
      ];
    })
    (automation "devices_3d_print_live_activity" {
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
                      chronometer = "{{ end_ts > 0 and not paused }}";
                      critical_text = "{{ progress }}%";
                      live_update = true;
                      notification_icon = "mdi:printer-3d-nozzle";
                      notification_icon_color = "{{ '#FFB300' if paused else '#00AE42' }}";
                      progress = "{{ progress }}";
                      progress_max = 100;
                      silent = true;
                      tag = "h2c_print";
                      when = "{{ end_ts }}";
                    };
                    message = "{{ task }} · {{ 'Paused' if paused else state_translated('${entities.sensor.balconyH2CCurrentStage}') }}{{ ' · layer ' ~ layer ~ '/' ~ layers if layers > 0 else '' }}";
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
                    ok = "{{ trigger.to_state.state == 'finish' }}";
                  };
                }
                {
                  action = "notify.mobile_app_iphone_15";
                  data = {
                    data = {
                      chronometer = false;
                      critical_text = "{{ 'Done' if ok else 'Failed' }}";
                      live_update = true;
                      notification_icon = "{{ 'mdi:check-circle' if ok else 'mdi:alert-circle' }}";
                      notification_icon_color = "{{ '#00AE42' if ok else '#E53935' }}";
                      progress = "{{ 100 if ok else progress }}";
                      progress_max = 100;
                      tag = "h2c_print";
                    };
                    message = "{{ task }} · {{ 'Finished' if ok else 'Failed' }}";
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
        end_ts = "{{ as_timestamp(states('${entities.sensor.balconyH2CEndTime}'), 0) | int }}";
        layer = "{{ states('${entities.sensor.balconyH2CCurrentLayer}') | int(0) }}";
        layers = "{{ states('${entities.sensor.balconyH2CTotalLayerCount}') | int(0) }}";
        paused = "{{ is_state('${entities.sensor.balconyH2CPrintStatus}', 'pause') }}";
        progress = "{{ states('${entities.sensor.balconyH2CPrintProgress}') | int(0) }}";
        task = "{{ states('${entities.sensor.balconyH2CTaskName}') if has_value('${entities.sensor.balconyH2CTaskName}') else 'Print' }}";
      };
    })
  ];
}
