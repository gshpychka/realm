let
  tab = "victron-charging-ramp";
  rampDurationMinutes = 30;
  controller = "victron-charging-ramp-controller";
  chargeLimitEntity = "number.cerbo_ess_max_charge_current";
  brokerId = "victron-charging-ramp-mqtt";
  telemetryRoot = "realm/victron/charging-ramp";
  # Command age includes transport delay and clock skew.
  commandMaxAgeSeconds = 30;
  throttleNode = "victron-charging-ramp-throttle";
  restoreScript = "victron_full_charging_now";
  throttleScript = "victron_throttle_charging";
  controlScript = "victron_toggle_charging";
  statusEntity = "sensor.victron_charging_ramp_status";
  gridReady = "states('${statusEntity}') not in ['unknown', 'unavailable'] and state_attr('${statusEntity}', 'ready') == true and state_attr('${statusEntity}', 'grid_source') == 1";
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
                name = "Victron charging ramp";
                manufacturer = "realm";
                model = "Node-RED charging controller";
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
  system = {
    service = "com.victronenergy.system";
    name = "Venus system";
  };
  settings = {
    service = "com.victronenergy.settings";
    name = "Venus settings";
  };
  source = {
    path = "/Ac/ActiveIn/Source";
    type = "enum";
    name = "AC-Input";
    enum = {
      "0" = "Not available";
      "1" = "Grid";
      "2" = "Generator";
      "3" = "Shore";
      "240" = "Inverting";
    };
  };
  limit = {
    path = "/Settings/SystemSetup/MaxChargeCurrent";
    type = "float";
    name = "DVCC Charge current limit (A)";
    mode = "both";
  };
  soc = {
    path = "/Dc/Battery/Soc";
    type = "float";
    name = "Battery state of charge (%)";
  };
in
{
  host = "192.168.1.236";
  certificateSha256 = "5ccd906f466267bc05cc30717fc5f570bfe9213e8ea4f8b0f1ab3de12f6d12aa";
  tabId = tab;
  controllerId = controller;
  overrideId = "victron-charging-ramp-full";
  throttleId = throttleNode;
  limitService = settings.service;
  limitPath = limit.path;
  telemetry = {
    inherit brokerId sensors;
    availabilityTopic = "${telemetryRoot}/availability";
    stateTopic = "${telemetryRoot}/state";
  };
  flows = [
    {
      id = tab;
      type = "tab";
      label = "Grid charging ramp";
      disabled = false;
      info = "Charging ramps to the inverter limit over ${toString rampDurationMinutes} minutes. Full charging overrides the remaining window until the battery is full or the window ends. An outage or runtime restart arms a fresh ramp.";
      env = [
        {
          name = "FULL_CHARGE_CURRENT_A";
          value = "140";
          type = "num";
        }
        {
          name = "RAMP_DURATION_SECONDS";
          value = toString (rampDurationMinutes * 60);
          type = "num";
        }
      ];
    }
    {
      id = "victron-charging-ramp-source";
      type = "victron-input-system";
      z = tab;
      name = "Grid source";
      inherit (system) service;
      serviceObj = system;
      inherit (source) path;
      pathObj = source;
      onlyChanges = true;
      roundValues = "no";
      outputs = 1;
      x = 140;
      y = 100;
      wires = [ [ "victron-charging-ramp-grid-topic" ] ];
    }
    {
      id = "victron-charging-ramp-grid-topic";
      type = "change";
      z = tab;
      name = "Grid";
      rules = [
        {
          t = "set";
          p = "topic";
          pt = "msg";
          to = "grid";
          tot = "str";
        }
      ];
      x = 350;
      y = 100;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-limit";
      type = "victron-input-ess";
      z = tab;
      name = "DVCC user limit";
      inherit (settings) service;
      serviceObj = settings;
      inherit (limit) path;
      pathObj = limit;
      onlyChanges = true;
      roundValues = "no";
      outputs = 1;
      x = 140;
      y = 180;
      wires = [ [ "victron-charging-ramp-limit-topic" ] ];
    }
    {
      id = "victron-charging-ramp-limit-topic";
      type = "change";
      z = tab;
      name = "Limit";
      rules = [
        {
          t = "set";
          p = "topic";
          pt = "msg";
          to = "limit";
          tot = "str";
        }
      ];
      x = 350;
      y = 180;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-full";
      type = "inject";
      z = tab;
      name = "Full charging now";
      props = [
        { p = "payload"; }
        {
          p = "topic";
          vt = "str";
        }
      ];
      topic = "full";
      payload = "";
      payloadType = "date";
      repeat = "";
      once = false;
      onceDelay = 0.1;
      x = 330;
      y = 260;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-soc";
      type = "victron-input-system";
      z = tab;
      name = "Battery state of charge";
      inherit (system) service;
      serviceObj = system;
      inherit (soc) path;
      pathObj = soc;
      onlyChanges = true;
      roundValues = "no";
      outputs = 1;
      x = 140;
      y = 20;
      wires = [ [ "victron-charging-ramp-soc-topic" ] ];
    }
    {
      id = "victron-charging-ramp-soc-topic";
      type = "change";
      z = tab;
      name = "Battery SOC";
      rules = [
        {
          t = "set";
          p = "topic";
          pt = "msg";
          to = "soc";
          tot = "str";
        }
      ];
      x = 350;
      y = 20;
      wires = [ [ controller ] ];
    }
    {
      id = throttleNode;
      type = "inject";
      z = tab;
      name = "Throttle charging";
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
      x = 330;
      y = 300;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-command";
      type = "mqtt in";
      z = tab;
      name = "Charging command";
      broker = brokerId;
      topic = "${telemetryRoot}/command";
      qos = "1";
      datatype = "json";
      nl = false;
      rap = true;
      rh = 0;
      x = 140;
      y = 580;
      wires = [ [ "victron-charging-ramp-command-check" ] ];
    }
    {
      id = "victron-charging-ramp-command-check";
      type = "function";
      z = tab;
      name = "Fresh throttle request";
      func = ''
        const command = msg.payload;
        if (msg.retain || !command || command.command !== "throttle" ||
            typeof command.issued_at !== "number" || !Number.isFinite(command.issued_at)) return null;
        const age = Date.now() / 1000 - command.issued_at;
        if (Math.abs(age) > ${toString commandMaxAgeSeconds}) return null;
        return {topic: "throttle"};
      '';
      outputs = 1;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 390;
      y = 580;
      wires = [ [ controller ] ];
    }
    {
      id = controller;
      type = "function";
      z = tab;
      name = "${toString rampDurationMinutes}-minute charging ramp";
      func = builtins.readFile ./charging-ramp.js;
      initialize = ''
        context.set("timer", null);
      '';
      finalize = ''
        const timer = context.get("timer");
        if (timer) clearInterval(timer);
      '';
      outputs = 2;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 620;
      y = 180;
      wires = [
        [ "victron-charging-ramp-output" ]
        [ "victron-charging-ramp-state" ]
      ];
    }
    {
      id = "victron-charging-ramp-output";
      type = "victron-output-ess";
      z = tab;
      name = "DVCC charging-current ceiling";
      inherit (settings) service;
      serviceObj = settings;
      inherit (limit) path;
      pathObj = limit;
      outputs = 0;
      x = 940;
      y = 180;
      wires = [ ];
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
      name = "Charging telemetry";
      broker = brokerId;
      topic = "${telemetryRoot}/state";
      qos = "0";
      retain = "false";
      x = 950;
      y = 260;
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
      x = 320;
      y = 340;
      wires = [ [ controller ] ];
    }
    {
      id = "victron-charging-ramp-discover";
      type = "inject";
      z = tab;
      name = "Register charging sensors";
      props = [ { p = "payload"; } ];
      payloadType = "date";
      repeat = "";
      once = true;
      onceDelay = 1;
      x = 320;
      y = 420;
      wires = [ [ "victron-charging-ramp-discovery" ] ];
    }
    {
      id = "victron-charging-ramp-discovery";
      type = "function";
      z = tab;
      name = "Home Assistant discovery";
      func = ''
        if (msg.status && msg.status.fill !== "green") return null;
        return [${builtins.toJSON (builtins.map (sensor: { inherit (sensor) topic payload; }) sensors)}];
      '';
      outputs = 1;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 610;
      y = 420;
      wires = [ [ "victron-charging-ramp-discovery-output" ] ];
    }
    {
      id = "victron-charging-ramp-mqtt-status";
      type = "status";
      z = tab;
      name = "Broker connection";
      scope = [ "victron-charging-ramp-state" ];
      x = 320;
      y = 500;
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
      x = 950;
      y = 420;
      wires = [ ];
    }
  ];
  homeAssistant = {
    dashboard = "victron-live";
    controlEntity = chargeLimitEntity;
    scripts.${restoreScript} = {
      alias = "Victron: full charging now";
      description = "Skip the remaining ramp until the battery is full or its original window ends.";
      icon = "mdi:flash";
      mode = "single";
      sequence = [
        {
          action = "number.set_value";
          target.entity_id = chargeLimitEntity;
          data = {
            value = -1;
          };
        }
      ];
    };
    scripts.${throttleScript} = {
      alias = "Victron: throttle charging";
      description = "Apply the charging ramp at its current point, opening a new window when needed.";
      icon = "mdi:gauge-low";
      mode = "single";
      sequence = [
        {
          action = "mqtt.publish";
          data = {
            topic = "${telemetryRoot}/command";
            payload = "{{ {'command': 'throttle', 'issued_at': as_timestamp(now())} | to_json }}";
            qos = 1;
            retain = false;
          };
        }
      ];
    };
    scripts.${controlScript} = {
      alias = "Victron: toggle charging ramp";
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
          default = [
            {
              condition = "template";
              value_template = "{{ ${gridReady} }}";
            }
            { action = "script.${throttleScript}"; }
          ];
        }
      ];
    };
    resourceFiles = [
      "mushroom.js"
      "layout-card.js"
    ];
    cardResource = {
      key = "victron-charging-card";
      source = builtins.readFile ./charging-chart.js;
    };
    view = {
      title = "Victron";
      path = "overview";
      type = "custom:grid-layout";
      layout = {
        grid-template-columns = "minmax(0, 240px) minmax(0, 1fr)";
        grid-template-areas = ''"charging ." "flow flow"'';

      };
      cards = [
        {
          type = "custom:mushroom-template-card";
          entity = statusEntity;
          primary = "Charging power";
          secondary = "{{ 'Restore' if is_state('${statusEntity}', 'Ramping') else 'Throttle' if ${gridReady} else '' }}";
          icon = "{{ 'mdi:flash' if is_state('${statusEntity}', 'Ramping') else 'mdi:gauge-low' }}";
          color = "{{ 'amber' if is_state('${statusEntity}', 'Ramping') else 'blue' if ${gridReady} else 'disabled' }}";
          vertical = true;
          features_position = "bottom";
          tap_action = {
            action = "perform-action";
            perform_action = "script.${controlScript}";
          };
          icon_tap_action = {
            action = "perform-action";
            perform_action = "script.${controlScript}";
          };
          hold_action.action = "more-info";
          view_layout.grid-area = "charging";
          features = [
            {
              type = "custom:victron-charging-chart";
              status_entity = statusEntity;
              bms_limit_entity = "sensor.battery_maximum_allowed_charge_current";
              policy_limit_entity = chargeLimitEntity;
              current_entity = "sensor.battery_dc_bus_current";
              soc_entity = "sensor.battery_charge";

              history_hours = 2;
            }
          ];
        }
        {
          type = "custom:victron-live-card";
          view_layout.grid-area = "flow";
        }
      ];
    };
  };
}
