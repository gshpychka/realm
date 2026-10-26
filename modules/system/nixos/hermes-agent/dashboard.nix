# The web dashboard (https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard):
# HTTP on loopback behind the host's reverse proxy, signed in to with Hermes's
# own password login.
#
# Imperative, one-time: generate the owner's password and the key that signs
# their sessions:
#   openssl rand -base64 24 | jq -R . | sops set --value-stdin <sopsFile> '["hermes-dashboard-password"]'
#   openssl rand -base64 32 | jq -R . | sops set --value-stdin <sopsFile> '["hermes-dashboard-secret"]'
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
in
{
  options.my.hermes-agent.publicHost = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "HTTPS host name the dashboard is reached at through the reverse proxy; null leaves the dashboard off.";
  };

  config = lib.mkIf (service.enable && cfg.publicHost != null) {
    services.hermes-agent = {
      backend.mode = "dashboard";
      settings.dashboard = {
        public_url = "https://${cfg.publicHost}";
        basic_auth.username = config.my.user;
      };
    };

    my.hermes-agent.secrets = {
      HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = "hermes-dashboard-password";
      HERMES_DASHBOARD_BASIC_AUTH_SECRET = "hermes-dashboard-secret";
    };
  };
}
