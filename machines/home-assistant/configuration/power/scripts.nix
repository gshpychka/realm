{ ha, ... }:
let
  inherit (ha)
    areas
    templates
    announce
    ;
  satellites = {
    target.area_id = areas.room;
  };
in
{
  services.home-assistant.config.script = builtins.mapAttrs (_: ha.script) {
    # Queued so power-change announcements play one after another: on
    # 2026-10-23 power returned 0.5s after the outage announcement started and
    # the second announce raised SatelliteBusyError.
    announce_power_change = {
      alias = "Power / Announce power change";
      description = "Speaks a power-change notification in the room once earlier announcements have finished.";
      fields = {
        message = {
          description = "The notification text to speak.";
          name = "Message";
          required = true;
          selector = {
            text = { };
          };
        };
      };
      mode = "queued";
      sequence = [
        {
          # Other automations speak on the same satellite outside this queue.
          # announce cancels a plain voice pipeline itself, but raises
          # SatelliteBusyError while another announcement or started
          # conversation plays; both report "responding", as does a spoken
          # voice reply, which this also avoids cutting off. After the timeout
          # announce runs anyway, and a still-busy satellite fails this run in
          # its own trace and log.
          alias = "Let another announcement finish";
          "if" = [
            (
              {
                condition = "assist_satellite.is_responding";
                options.behavior = "any";
              }
              // satellites
            )
          ];
          "then" = [
            {
              wait_for_trigger = [
                (
                  {
                    trigger = "assist_satellite.idle";
                    options.behavior = "last";
                  }
                  // satellites
                )
              ];
              timeout.minutes = 2;
            }
          ];
        }
        (announce templates.message { preannounce = true; })
      ];
    };
  };
}
