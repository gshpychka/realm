# Hermes owns its login, session cookies and WebSocket tickets. A public URL
# engages that native gate even though nginx reaches the backend on loopback.
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  dashboard = cfg.dashboard;
  published = cfg.enable && dashboard.enable && dashboard.publicHost != null;
in
{
  options.my.hermes-agent.dashboard = {
    publicHost = lib.mkOption {
      type = lib.types.nullOr lib.types.nonEmptyStr;
      default = null;
      example = "hermes.hoard.glib.sh";
      description = "HTTPS dashboard hostname without a scheme or path; null keeps the dashboard local.";
    };
    username = lib.mkOption {
      type = lib.types.nonEmptyStr;
      default = config.my.user;
      description = "Username for Hermes's native single-account dashboard login.";
    };
  };

  config = lib.mkIf published {
    assertions = [
      {
        assertion = builtins.match "[A-Za-z0-9.-]+" dashboard.publicHost != null;
        message = "my.hermes-agent.dashboard.publicHost must be a DNS hostname without a scheme, port or path.";
      }
    ];

    services.hermes-agent.settings.dashboard = {
      public_url = "https://${dashboard.publicHost}";
      basic_auth.username = dashboard.username;
    };

    # Reuse OpenClaw's existing high-entropy administrator credential through
    # the same SOPS environment mapping as every other integration. The native
    # password provider hashes it in memory and signs its own browser sessions.
    my.hermes-agent.secrets = {
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = lib.mkDefault "gateway-token";
      HERMES_DASHBOARD_BASIC_AUTH_SECRET = lib.mkDefault "gateway-token";
    };
  };
}
