# Hermes Agent's services on this host, from its NixOS module
# (https://hermes-agent.nousresearch.com/docs/getting-started/nix-setup).
{
  config,
  lib,
  inputs,
  ...
}:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
  # the event-loop watchdog (https://hermes-agent.nousresearch.com/docs/user-guide/messaging#optional-linux-event-loop-watchdog)
  watchdogSeconds = 120;
in
{
  imports = [ inputs.hermes-agent.nixosModules.default ];

  options.my.hermes-agent.units = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    readOnly = true;
    default = [ "hermes-agent" ] ++ lib.optional (service.backend.mode != "none") "hermes-backend";
    description = "The systemd services running Hermes: its gateway, and its backend when there is one.";
  };

  config = lib.mkIf service.enable {
    services.hermes-agent = {
      # the `hermes` CLI in the service user's login shells (`sudo -iu hermes`)
      extraPackages = [ service.package ];
      settings.gateway.systemd_watchdog_seconds = watchdogSeconds;
    };

    systemd.services = lib.mkMerge [
      (lib.genAttrs cfg.units (_: {
        # activation rewrites config.yaml and .env, which the units' definitions leave out
        restartTriggers = [
          (builtins.toJSON {
            inherit (service) settings environment;
          })
        ];
      }))
      {
        # the gateway reports ready, and then alive within each watchdog interval, over sd_notify
        hermes-agent.serviceConfig = {
          Type = "notify";
          NotifyAccess = "main";
          WatchdogSec = watchdogSeconds;
        };
      }
    ];

    # the daemon admits only listed users
    nix.settings.allowed-users = [ service.user ];
  };
}
