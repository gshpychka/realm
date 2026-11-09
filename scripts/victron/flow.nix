let
  tab = "victron-charging-ramp";
  controller = "victron-charging-ramp-controller";
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
in
{
  host = "192.168.1.236";
  certificateSha256 = "5ccd906f466267bc05cc30717fc5f570bfe9213e8ea4f8b0f1ab3de12f6d12aa";
  tabId = tab;
  controllerId = controller;
  overrideId = "victron-charging-ramp-full";
  limitService = settings.service;
  limitPath = limit.path;
  flows = [
    {
      id = tab;
      type = "tab";
      label = "Grid charging ramp";
      disabled = false;
      info = "Charging ramps to the inverter limit over 30 minutes. Full charging overrides this grid-connected period; an outage or restart arms a fresh ramp. DVCC battery protections remain active.";
      env = [
        {
          name = "FULL_CHARGE_CURRENT_A";
          value = "140";
          type = "num";
        }
        {
          name = "RAMP_DURATION_SECONDS";
          value = "1800";
          type = "num";
        }
      ];
    }
    {
      id = "victron-charging-ramp-source";
      type = "victron-input-system";
      z = tab;
      name = "Grid source";
      service = system.service;
      serviceObj = system;
      path = source.path;
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
      service = settings.service;
      serviceObj = settings;
      path = limit.path;
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
      id = controller;
      type = "function";
      z = tab;
      name = "30-minute charging ramp";
      func = builtins.readFile ./charging-ramp.js;
      initialize = ''
        context.set("state", null);
        context.set("timer", null);
      '';
      finalize = ''
        const timer = context.get("timer");
        if (timer) clearInterval(timer);
      '';
      outputs = 1;
      timeout = 0;
      noerr = 0;
      libs = [ ];
      x = 620;
      y = 180;
      wires = [ [ "victron-charging-ramp-output" ] ];
    }
    {
      id = "victron-charging-ramp-output";
      type = "victron-output-ess";
      z = tab;
      name = "DVCC charging-current ceiling";
      service = settings.service;
      serviceObj = settings;
      path = limit.path;
      pathObj = limit;
      outputs = 0;
      x = 940;
      y = 180;
      wires = [ ];
    }
  ];
  homeAssistant = {
    dashboard = "victron-live";
    scriptId = "victron_full_charging_now";
    script = {
      alias = "Victron: full charging now";
      description = "Normal charging until the next grid outage.";
      icon = "mdi:flash";
      mode = "single";
      sequence = [
        {
          action = "victron_mqtt.publish";
          data = {
            metric_id = "system_ess_max_charge_current";
            device_id = "0";
            value = -1;
          };
        }
      ];
    };
    view = {
      title = "Charging";
      path = "charging";
      type = "sections";
      max_columns = 1;
      sections = [
        {
          type = "grid";
          cards = [
            {
              type = "shortcut";
              label = "Full charging now";
              icon = "mdi:flash";
              tap_action = {
                action = "perform-action";
                perform_action = "script.victron_full_charging_now";
                confirmation.text = "Cancel the charging ramp until the next grid outage?";
              };
            }
          ];
        }
      ];
    };
  };
}
