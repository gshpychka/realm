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
    credentialsFile = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.stateDir}/dashboard.env";
      description = ''
        Runtime environment file holding HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH
        (or PASSWORD) and a stable HERMES_DASHBOARD_BASIC_AUTH_SECRET. Use a
        private local file or a SOPS-rendered path, never a Nix path literal.
        The network-facing backend waits for this file before starting.
      '';
    };
  };

  config = lib.mkIf published {
    assertions = [
      {
        assertion = builtins.match "[A-Za-z0-9.-]+" dashboard.publicHost != null;
        message = "my.hermes-agent.dashboard.publicHost must be a DNS hostname without a scheme, port or path.";
      }
      {
        assertion = lib.hasPrefix "/" dashboard.credentialsFile;
        message = "my.hermes-agent.dashboard.credentialsFile must be an absolute runtime path.";
      }
    ];

    services.hermes-agent.settings.dashboard = {
      public_url = "https://${dashboard.publicHost}";
      basic_auth.username = dashboard.username;
    };

    # Feed the existing upstream dotenv refresh path. Hermes's bundled basic
    # provider handles password verification and session signing itself.
    my.hermes-agent.environmentFiles = [ "-${dashboard.credentialsFile}" ];
    systemd.services.hermes-backend.unitConfig.ConditionPathExists = dashboard.credentialsFile;

    environment.etc."hermes-agent/dashboard.env.example".text = ''
      # Template only. Keep real credentials out of /etc, Nix and git.
      # Install the completed file as ${dashboard.credentialsFile}, owned by
      # ${cfg.user}:${cfg.user}, mode 0600, then start/restart hermes-backend.
      # The configured username is ${dashboard.username}.
      #
      # Preferred: a scrypt hash from Hermes's native hash_password helper.
      # HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=REPLACE_WITH_SCRYPT_HASH
      # Alternative: plaintext password in this private runtime file. Set only
      # one of PASSWORD_HASH and PASSWORD; a PASSWORD value takes precedence.
      # HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=REPLACE_WITH_STRONG_PASSWORD
      #
      # Independent persistent token-signing key (for example 32 random bytes
      # encoded as base64). Keep it stable so sessions survive restarts.
      # HERMES_DASHBOARD_BASIC_AUTH_SECRET=REPLACE_WITH_RANDOM_SIGNING_SECRET
    '';
  };
}
