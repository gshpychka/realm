# OnFailure handler for any unit on a notifying host (modules/system/common/notifications.nix):
#   systemd.services.<name>.onFailure = [ "notify-unit-failure@%n.service" ];
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.notifications;
in
{
  config = lib.mkIf (lib.elem config.networking.hostName cfg.senders) {
    systemd.services."notify-unit-failure@" = {
      description = "Notify that %i failed";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.writeShellScript "notify-unit-failure" ''
          ${config.systemd.package}/bin/journalctl --unit "$1" --lines 20 --no-pager --output cat \
            | ${cfg.package}/bin/notify -p 4 -t warning "$1 failed"
        ''} %i";
      };
    };
  };
}
