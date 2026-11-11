let
  tab = "victron-charging-ramp";
  controller = "victron-charging-ramp-controller";
  rampDefaults = {
    enabled = true;
    duration_minutes = 60;
    start_current_a = 0;
    target_current_a = 43.5;
  };
  settingsFile = "/data/home/nodered/.node-red/realm-grid-ramp.json";
  rampStepSeconds = 60;
  minimumOutageMinutes = 30;
  outageMarginMinutes = 30;
  # Conservative recharge budget includes the final charging stage.
  rechargeMinutesPerPercent = 3;
  rechargeTailMinutes = 10;
  outageEntities = [
    "sensor.yasno_next_planned_outage"
    "sensor.yasno_next_probable_outage"
  ];
  scheduleAutomationId = "victron_grid_ramp_schedule";
  normalInputCurrentA = 63;
  nominalInputVoltageV = 230;
  inputLimitEntity = "number.multiplus_current_limit";
  ignoreEntity = "switch.multiplus_control_ignore_ac_in_1";
  brokerId = "victron-charging-ramp-mqtt";
  telemetryRoot = "realm/victron/charging-ramp";
  commandMaxAgeSeconds = 30;
  throttleNode = "victron-charging-ramp-throttle";
  restoreScript = "victron_full_charging_now";
  throttleScript = "victron_throttle_charging";
  controlScript = "victron_toggle_charging";
  statusEntity = "sensor.victron_charging_ramp_status";
  gridReady = "states('${statusEntity}') not in ['unknown', 'unavailable'] and state_attr('${statusEntity}', 'ready') == true and state_attr('${statusEntity}', 'grid_available') == true";
  frontendDirectory = builtins.readDir ./dashboard;
  system = {
    service = "com.victronenergy.system";
    name = "Venus system";
  };
  vebus = {
    service = "com.victronenergy.vebus/276";
    name = "MultiPlus-II";
  };
  battery = {
    service = "com.victronenergy.battery/512";
    name = "Battery BMS";
  };
  limit = {
    path = "/Ac/In/1/CurrentLimit";
    type = "float";
    name = "Input current limit (A)";
    mode = "both";
  };
  ignore = {
    path = "/Ac/Control/IgnoreAcIn1";
    type = "enum";
    name = "Ignore AC input 1";
    enum = {
      "0" = "Use input";
      "1" = "Ignore input";
    };
    mode = "both";
    writable = true;
  };
  inputNodes = spec: [
    {
      id = "${tab}-${spec.topic}-input";
      type = "victron-input-${spec.type}";
      z = tab;
      inherit (spec) name;
      inherit (spec.service) service;
      serviceObj = spec.service;
      inherit (spec.path) path;
      pathObj = spec.path;
      onlyChanges = true;
      roundValues = "no";
      outputs = 1;
      x = 160;
      inherit (spec) y;
      wires = [ [ "${tab}-${spec.topic}-topic" ] ];
    }
    {
      id = "${tab}-${spec.topic}-topic";
      type = "change";
      z = tab;
      inherit (spec) name;
      rules = [
        {
          t = "set";
          p = "topic";
          pt = "msg";
          to = spec.topic;
          tot = "str";
        }
      ];
      x = 390;
      inherit (spec) y;
      wires = [ [ controller ] ];
    }
  ];
  sensors =
    builtins.map
      (
        spec:
        let
          id = "victron_charging_ramp_${spec.key}";
        in
        {
          entityId = "sensor.${id}";
          topic = "homeassistant/sensor/${id}/config";
          payload = builtins.toJSON (
            {
              unique_id = id;
              default_entity_id = "sensor.${id}";
              state_topic = "${telemetryRoot}/state";
              availability_topic = "${telemetryRoot}/availability";
              payload_available = "online";
              payload_not_available = "offline";
              expire_after = 45;
              enabled_by_default = true;
              device = {
                identifiers = [ "realm_victron_charging_ramp" ];
                name = "Victron grid input";
                manufacturer = "realm";
                model = "Node-RED input controller";
              };
            }
            // spec.config
          );
        }
      )
      [
        {
          key = "status";
          config = {
            name = "Status";
            icon = "mdi:state-machine";
            value_template = "{{ value_json.state }}";
            json_attributes_topic = "${telemetryRoot}/state";
          };
        }
        {
          key = "elapsed";
          config = {
            name = "Elapsed";
            device_class = "duration";
            unit_of_measurement = "s";
            value_template = "{{ value_json.elapsed_seconds }}";
          };
        }
        {
          key = "remaining";
          config = {
            name = "Remaining";
            device_class = "duration";
            unit_of_measurement = "s";
            value_template = "{{ value_json.remaining_seconds }}";
          };
        }
      ];
  settingNumbers =
    builtins.map
      (
        spec:
        let
          id = "victron_grid_ramp_${spec.suffix}";
        in
        {
          entityId = "number.${id}";
          topic = "homeassistant/number/${id}/config";
          payload = builtins.toJSON {
            unique_id = id;
            default_entity_id = "number.${id}";
            inherit (spec) name;
            entity_category = "config";
            state_topic = "${telemetryRoot}/state";
            value_template = "{{ value_json.configured_${spec.key} }}";
            command_topic = "${telemetryRoot}/config/${spec.key}";
            command_template = "{{ value }}";
            inherit (spec) min max step;
            unit_of_measurement = spec.unit;
            mode = "box";
            qos = 1;
            retain = false;
            optimistic = false;
            availability_topic = "${telemetryRoot}/availability";
            payload_available = "online";
            payload_not_available = "offline";
            json_attributes_topic = "${telemetryRoot}/state";
            json_attributes_template = "{{ {'default_value': value_json.defaults.${spec.key}} | to_json }}";
            device = {
              identifiers = [ "realm_victron_charging_ramp" ];
              name = "Victron grid input";
              manufacturer = "realm";
              model = "Node-RED input controller";
            };
          };
        }
      )
      [
        {
          key = "duration_minutes";
          suffix = "duration";
          name = "Ramp duration";
          unit = "min";
          min = 1;
          max = 1440;
          step = 1;
        }
        {
          key = "start_current_a";
          suffix = "start_current";
          name = "Starting current";
          unit = "A";
          min = 0;
          max = normalInputCurrentA;
          step = 0.1;
        }
        {
          key = "target_current_a";
          suffix = "target_current";
          name = "Target current";
          unit = "A";
          min = 0;
          max = normalInputCurrentA;
          step = 0.1;
        }
      ];
  enabledSwitch = {
    entityId = "switch.victron_grid_ramp_enabled";
    topic = "homeassistant/switch/victron_grid_ramp_enabled/config";
    payload = builtins.toJSON {
      unique_id = "victron_grid_ramp_enabled";
      default_entity_id = "switch.victron_grid_ramp_enabled";
      name = "Automatic ramp";
      entity_category = "config";
      state_topic = "${telemetryRoot}/state";
      value_template = "{{ 'ON' if value_json.enabled else 'OFF' }}";
      command_topic = "${telemetryRoot}/config/enabled";
      payload_on = "ON";
      payload_off = "OFF";
      qos = 1;
      retain = false;
      optimistic = false;
      availability_topic = "${telemetryRoot}/availability";
      payload_available = "online";
      payload_not_available = "offline";
      device = {
        identifiers = [ "realm_victron_charging_ramp" ];
        name = "Victron grid input";
        manufacturer = "realm";
        model = "Node-RED input controller";
      };
    };
  };
  resetButton = {
    entityId = "button.victron_grid_ramp_reset_defaults";
    topic = "homeassistant/button/victron_grid_ramp_reset_defaults/config";
    payload = builtins.toJSON {
      unique_id = "victron_grid_ramp_reset_defaults";
      default_entity_id = "button.victron_grid_ramp_reset_defaults";
      name = "Reset ramp defaults";
      entity_category = "config";
      icon = "mdi:restore";
      command_topic = "${telemetryRoot}/config/reset";
      payload_press = "reset";
      qos = 1;
      retain = false;
      availability_topic = "${telemetryRoot}/availability";
      payload_available = "online";
      payload_not_available = "offline";
      device = {
        identifiers = [ "realm_victron_charging_ramp" ];
        name = "Victron grid input";
        manufacturer = "realm";
        model = "Node-RED input controller";
      };
    };
  };
  discovery =
    sensors
    ++ settingNumbers
    ++ [
      enabledSwitch
      resetButton
    ];
  commandSequence = command: {
    action = "mqtt.publish";
    data = {
      topic = "${telemetryRoot}/command";
      payload = "{{ {'command': '${command}', 'issued_at': as_timestamp(now())} | to_json }}";
      qos = 1;
      retain = false;
    };
  };
in
{
  host = "192.168.1.236";
  certificateSha256 = "5ccd906f466267bc05cc30717fc5f570bfe9213e8ea4f8b0f1ab3de12f6d12aa";
  tabId = tab;
  controllerId = controller;
  overrideId = "victron-charging-ramp-full";
  throttleId = throttleNode;
  limitService = vebus.service;
  limitPath = limit.path;
  batteryService = battery.service;
  ignoreService = vebus.service;
  ignorePath = ignore.path;
  ignoreStatePath = "/Ac/State/IgnoreAcIn1";
  inherit normalInputCurrentA;
  stateKey = "gridRamp";
  inherit rampDefaults settingsFile;
  telemetry = {
    inherit brokerId sensors discovery;
    settingsEntities = builtins.map (item: item.entityId) (settingNumbers ++ [ enabledSwitch ]);
    settingsTopics = builtins.map (item: item.topic) (
      settingNumbers
      ++ [
        enabledSwitch
        resetButton
      ]
    );
    availabilityTopic = "${telemetryRoot}/availability";
    stateTopic = "${telemetryRoot}/state";
  };
  flows = [
    {
      id = tab;
      type = "tab";
      label = "Grid input ramp";
      disabled = false;
      info = "Grid restoration after at least ${toString minimumOutageMinutes} minutes without mains starts a ramp. A grid-input ramp uses its saved duration, starting current and target current. Defaults are ${toString rampDefaults.duration_minutes} minutes, ${toString rampDefaults.start_current_a} A and ${toString rampDefaults.target_current_a} A. Numeric edits apply to the next ramp; automatic-ramp enable changes apply immediately. Reset restores only numeric defaults. The inverter enforces its native current floor; completion restores the normal input limit.";
      env = [
        {
          name = "DEFAULT_ENABLED";
          value = if rampDefaults.enabled then "true" else "false";
          type = "bool";
        }
        {
          name = "DEFAULT_DURATION_MINUTES";
          value = toString rampDefaults.duration_minutes;
          type = "num";
        }
        {
          name = "DEFAULT_START_CURRENT_A";
          value = toString rampDefaults.start_current_a;
          type = "num";
        }
        {
          name = "DEFAULT_TARGET_CURRENT_A";
          value = toString rampDefaults.target_current_a;
          type = "num";
        }
        {
          name = "RAMP_SETTINGS_FILE";
          value = settingsFile;
          type = "str";
        }
        {
          name = "RAMP_STEP_SECONDS";
          value = toString rampStepSeconds;
          type = "num";
        }
        {
          name = "MINIMUM_OUTAGE_SECONDS";
          value = toString (minimumOutageMinutes * 60);
          type = "num";
        }
        {
          name = "OUTAGE_MARGIN_SECONDS";
          value = toString (outageMarginMinutes * 60);
          type = "num";
        }
        {
          name = "RECHARGE_SECONDS_PER_PERCENT";
          value = toString (rechargeMinutesPerPercent * 60);
          type = "num";
        }
        {
          name = "RECHARGE_TAIL_SECONDS";
          value = toString (rechargeTailMinutes * 60);
          type = "num";
        }
        {
          name = "NORMAL_INPUT_CURRENT_A";
          value = toString normalInputCurrentA;
          type = "num";
        }
        {
          name = "NOMINAL_INPUT_VOLTAGE_V";
          value = toString nominalInputVoltageV;
          type = "num";
        }
      ];
    }
  ]
  ++ builtins.concatLists (
    builtins.map inputNodes [
      {
        topic = "available";
        type = "custom";
        name = "Mains physically available";
        service = vebus;
        path = {
          path = "/Ac/State/AcIn1Available";
          type = "enum";
          name = "AC input 1 available";
          enum = {
            "0" = "Unavailable";
            "1" = "Available";
          };
        };
        y = 60;
      }
      {
        topic = "voltage";
        type = "vebus";
        name = "Input voltage";
        service = vebus;
        path = {
          path = "/Ac/ActiveIn/L1/V";
          type = "float";
          name = "Input voltage (V)";
        };
        y = 120;
      }
      {
        topic = "limit";
        type = "vebus";
        name = "Accepted input limit";
        service = vebus;
        path = limit;
        y = 180;
      }
      {
        topic = "ignore";
        type = "custom";
        name = "Actual input isolation";
        service = vebus;
        path = {
          path = "/Ac/State/IgnoreAcIn1";
          type = "enum";
          name = "Input 1 ignored";
          enum = {
            "0" = "Connected";
            "1" = "Ignored";
          };
        };
        y = 240;
      }
      {
        topic = "soc";
        type = "system";
        name = "Battery state of charge";
        service = system;
        path = {
          path = "/Dc/Battery/Soc";
          type = "float";
          name = "Battery state of charge (%)";
        };
        y = 300;
      }
      {
        topic = "discharge";
        type = "battery";
        name = "BMS discharge allowance";
        service = battery;
        path = {
          path = "/Info/MaxDischargeCurrent";
          type = "float";
          name = "BMS maximum discharge current (A)";
        };
        y = 340;
      }

    ]
  )
  ++ [
    {
      id = "victron-charging-ramp-full";
      type = "inject";
      z = tab;
      name = "Restore normal input";
      props = [
        { p = "payload"; }
        {
          p = "topic";
          vt = "str";
        }
      ];
      topic = "full";
      payloadType = "date";
      repeat = "";
      once = false;
      onceDelay = 0.1;
      x = 390;
      y = 360;
      wires = [ [ controller ] ];
    }
    {
      id = throttleNode;
      type = "inject";
      z = tab;
      name = "Ramp grid input";
      props = [
        { p = "payload"; }
        {
          p = "topic";
          vt = "str";
        }
      ];
      topic = "throttle";
      payloadType = "date";
      repeat = "";
      once = false;
      x = 390;
      y = 400;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-command";
      type = "mqtt in";
      z = tab;
      name = "Input command";
      broker = brokerId;
      topic = "${telemetryRoot}/command";
      qos = "1";
      datatype = "json";
      nl = false;
      rap = true;
      rh = 0;
      x = 160;
      y = 560;
      wires = [ [ "victron-charging-ramp-command-check" ] ];
    }
    {
      id = "victron-charging-ramp-command-check";
      type = "function";
      z = tab;
      name = "Fresh input request";
      func = ''
        const command = msg.payload;
        if (msg.retain || !command || !["full", "throttle", "schedule"].includes(command.command) ||
            typeof command.issued_at !== "number" || !Number.isFinite(command.issued_at)) return null;
        const age = Date.now() / 1000 - command.issued_at;
        if (Math.abs(age) > ${toString commandMaxAgeSeconds}) return null;
        return {topic: command.command, payload: command.next_outage_at};
      '';
      outputs = 1;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 390;
      y = 560;
      wires = [ [ controller ] ];
    }
    {
      id = controller;
      type = "function";
      z = tab;
      name = "Configurable input ramp";
      func = builtins.readFile ./charging-ramp.js;
      initialize = ''
        context.set("timer", null);
        context.set("limitWrite", null);
      '';
      finalize = ''
        const timer = context.get("timer");
        if (timer) clearInterval(timer);

      '';
      outputs = 3;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 650;
      y = 180;
      wires = [
        [ "victron-charging-ramp-output" ]
        [ "victron-charging-ramp-ignore-output" ]
        [ "victron-charging-ramp-state" ]
      ];
    }
    {
      id = "victron-charging-ramp-output";
      type = "victron-output-vebus";
      z = tab;
      name = "AC input current ceiling";
      inherit (vebus) service;
      serviceObj = vebus;
      inherit (limit) path;
      pathObj = limit;
      outputs = 0;
      x = 980;
      y = 180;
      wires = [ ];
    }
    {
      id = "victron-charging-ramp-ignore-output";
      type = "victron-output-custom";
      z = tab;
      name = "AC input connection";
      inherit (vebus) service;
      serviceObj = vebus;
      inherit (ignore) path;
      pathObj = ignore;
      outputs = 0;
      x = 980;
      y = 240;
      wires = [ ];
    }
    {
      id = "victron-charging-ramp-limit-write";
      type = "status";
      z = tab;
      name = "Current write completion";
      scope = [ "victron-charging-ramp-output" ];
      x = 980;
      y = 290;
      wires = [ [ "victron-charging-ramp-limit-write-topic" ] ];
    }
    {
      id = "victron-charging-ramp-limit-write-topic";
      type = "change";
      z = tab;
      name = "Current write result";
      rules = [
        {
          t = "set";
          p = "topic";
          pt = "msg";
          to = "limit-write";
          tot = "str";
        }
      ];
      x = 650;
      y = 290;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-settings-load";
      type = "inject";
      z = tab;
      name = "Load saved ramp settings";
      props = [
        { p = "payload"; }
        {
          p = "topic";
          vt = "str";
        }
      ];
      topic = "load";
      payloadType = "date";
      repeat = "";
      once = true;
      onceDelay = 0.1;
      x = 160;
      y = 760;
      wires = [ [ "victron-charging-ramp-settings" ] ];
    }
    {
      id = "victron-charging-ramp-settings-command";
      type = "mqtt in";
      z = tab;
      name = "Ramp configuration";
      broker = brokerId;
      topic = "${telemetryRoot}/config/+";
      qos = "1";
      datatype = "utf8";
      nl = false;
      rap = true;
      rh = 0;
      x = 160;
      y = 820;
      wires = [ [ "victron-charging-ramp-settings" ] ];
    }
    {
      id = "victron-charging-ramp-settings";
      type = "function";
      z = tab;
      name = "Persistent ramp settings";
      func = builtins.readFile ./ramp-settings.js;
      initialize = "";
      finalize = "";
      outputs = 1;
      timeout = 0;
      noerr = 0;
      libs = [
        {
          var = "fs";
          module = "fs";
        }
      ];
      x = 430;
      y = 760;
      wires = [ [ controller ] ];
    }
    {
      id = brokerId;
      type = "mqtt-broker";
      z = tab;
      name = "Home Assistant telemetry";
      broker = "homeassistant.glib.sh";
      port = 1883;
      clientid = "realm-victron-charging-ramp";
      autoConnect = true;
      usetls = false;
      protocolVersion = 4;
      keepalive = 15;
      cleansession = true;
      birthTopic = "${telemetryRoot}/availability";
      birthPayload = "online";
      birthQos = "1";
      birthRetain = "true";
      closeTopic = "${telemetryRoot}/availability";
      closePayload = "offline";
      closeQos = "1";
      closeRetain = "true";
      willTopic = "${telemetryRoot}/availability";
      willPayload = "offline";
      willQos = "1";
      willRetain = "true";
    }
    {
      id = "victron-charging-ramp-state";
      type = "mqtt out";
      z = tab;
      name = "Input telemetry";
      broker = brokerId;
      topic = "${telemetryRoot}/state";
      qos = "0";
      retain = "false";
      x = 980;
      y = 300;
      wires = [ ];
    }
    {
      id = "victron-charging-ramp-heartbeat";
      type = "inject";
      z = tab;
      name = "Telemetry heartbeat";
      props = [
        { p = "payload"; }
        {
          p = "topic";
          vt = "str";
        }
      ];
      topic = "status";
      payloadType = "date";
      repeat = "10";
      once = true;
      onceDelay = 1;
      x = 390;
      y = 440;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-discover";
      type = "inject";
      z = tab;
      name = "Register input sensors";
      props = [ { p = "payload"; } ];
      payloadType = "date";
      repeat = "";
      once = true;
      onceDelay = 1;
      x = 390;
      y = 620;
      wires = [ [ "victron-charging-ramp-discovery" ] ];
    }
    {
      id = "victron-charging-ramp-discovery";
      type = "function";
      z = tab;
      name = "Home Assistant discovery";
      func = ''
        if (msg.status && msg.status.fill !== "green") return null;
        return [${builtins.toJSON (builtins.map (sensor: { inherit (sensor) topic payload; }) discovery)}];
      '';
      outputs = 1;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 650;
      y = 620;
      wires = [ [ "victron-charging-ramp-discovery-output" ] ];
    }
    {
      id = "victron-charging-ramp-mqtt-status";
      type = "status";
      z = tab;
      name = "Broker connection";
      scope = [ "victron-charging-ramp-state" ];
      x = 390;
      y = 680;
      wires = [ [ "victron-charging-ramp-discovery" ] ];
    }
    {
      id = "victron-charging-ramp-discovery-output";
      type = "mqtt out";
      z = tab;
      name = "Retained sensor definitions";
      broker = brokerId;
      topic = "";
      qos = "1";
      retain = "true";
      x = 980;
      y = 620;
      wires = [ ];
    }
  ];
  homeAssistant = {
    scheduleAutomation = {
      id = scheduleAutomationId;
      config = {
        id = scheduleAutomationId;
        alias = "Victron: publish outage schedule";
        description = "Send the next planned or probable outage to the local grid-input controller.";
        initial_state = true;
        mode = "restart";
        triggers = [
          {
            trigger = "state";
            entity_id = outageEntities;
          }
          {
            trigger = "time_pattern";
            minutes = "/1";
          }
          {
            trigger = "homeassistant";
            event = "start";
          }
          {
            trigger = "mqtt";
            topic = "${telemetryRoot}/availability";
            payload = "online";
          }
        ];
        conditions = [ ];
        actions = [
          {
            action = "mqtt.publish";
            data = {
              topic = "${telemetryRoot}/command";
              qos = 1;
              retain = false;
              payload = ''
                {% set ns = namespace(times=[]) %}
                {% for entity in ${builtins.toJSON outageEntities} %}
                  {% set at = as_timestamp(states(entity), none) %}
                  {% if at is not none and at > as_timestamp(now()) %}
                    {% set ns.times = ns.times + [at] %}
                  {% endif %}
                {% endfor %}
                {{ {'command': 'schedule', 'next_outage_at': ns.times | min if ns.times else none, 'issued_at': as_timestamp(now())} | to_json }}
              '';
            };
          }
        ];
      };
    };
    dashboard = "victron-live";
    controlEntity = inputLimitEntity;
    controlEntities = [
      inputLimitEntity
      ignoreEntity
    ];
    scripts.${restoreScript} = {
      alias = "Victron: restore normal grid input";
      description = "Release the input ramp and reconnect mains at the normal current limit.";
      icon = "mdi:flash";
      mode = "single";
      sequence = [
        ((commandSequence "full") // { continue_on_error = true; })
        {
          action = "number.set_value";
          target.entity_id = inputLimitEntity;
          data.value = normalInputCurrentA;
        }
        {
          action = "switch.turn_off";
          target.entity_id = ignoreEntity;
        }
      ];
    };
    scripts.${throttleScript} = {
      alias = "Victron: ramp grid input";
      description = "Apply the input ramp at its current point, opening a new window when needed.";
      icon = "mdi:gauge-low";
      mode = "single";
      sequence = [
        {
          condition = "template";
          value_template = "{{ state_attr('${statusEntity}', 'enabled') == true }}";
        }
        (commandSequence "throttle")
      ];
    };
    scripts.${controlScript} = {
      alias = "Victron: toggle grid-input ramp";
      icon = "mdi:gauge";
      mode = "single";
      sequence = [
        {
          choose = [
            {
              conditions = [
                {
                  condition = "state";
                  entity_id = statusEntity;
                  state = "Ramping";
                }
              ];
              sequence = [ { action = "script.${restoreScript}"; } ];
            }
          ];
        }
      ];
    };
    resourceFiles = [
      "mushroom.js"
      "layout-card.js"
    ];
    frontendAssets = builtins.listToAttrs (
      builtins.map
        (name: {
          inherit name;
          value = builtins.readFile (./dashboard + "/${name}");
        })
        (
          builtins.filter (name: frontendDirectory.${name} == "regular") (
            builtins.attrNames frontendDirectory
          )
        )
    );
    cardResource = {
      key = "victron-charging-card";
      source = builtins.readFile ./charging-chart.js;
    };
    view = {
      title = "Victron";
      path = "overview";
      type = "custom:grid-layout";
      layout = {
        grid-template-columns = "minmax(0, 620px)";
        grid-template-areas = ''"flow" "charging"'';
        grid-template-rows = "auto auto";
        justify-content = "center";
        align-items = "start";
        grid-gap = "16px";

      };
      cards = [
        {
          type = "vertical-stack";
          view_layout.grid-area = "flow";
          cards = [ { type = "custom:victron-system-card"; } ];
        }
        {
          type = "custom:victron-ramp-card";
          view_layout.grid-area = "charging";
          card = {
            type = "custom:mushroom-template-card";
            entity = statusEntity;
            primary = "Input ramp";
            secondary = "{{ 'Ramping' if is_state('${statusEntity}', 'Ramping') else 'Skipped' if is_state('${statusEntity}', 'Input override') else 'Ramp off' if state_attr('${statusEntity}', 'enabled') == false else 'No grid power' if state_attr('${statusEntity}', 'enabled') == true and state_attr('${statusEntity}', 'grid_available') == false else 'Ramp enabled' }}";
            icon = "{{ 'mdi:flash' if is_state('${statusEntity}', 'Ramping') else 'mdi:gauge-low' }}";
            color = "{{ 'amber' if is_state('${statusEntity}', 'Ramping') else 'disabled' if state_attr('${statusEntity}', 'enabled') == false else 'blue' if ${gridReady} else 'disabled' }}";
            vertical = false;
            features_position = "bottom";
            tap_action = {
              action = "none";
            };
            icon_tap_action = {
              action = "more-info";
            };
            hold_action.action = "more-info";
            features = [
              {
                type = "custom:victron-charging-chart";
                status_entity = statusEntity;
                power_entity = "sensor.multiplus_input_power_l1";

                history_hours = 12;
                outage_margin_seconds = outageMarginMinutes * 60;
              }
            ];
          };
        }
      ];
    };
  };
}
