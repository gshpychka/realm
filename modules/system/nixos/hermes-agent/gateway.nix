# The upstream module owns packaging, mutable config merges and persistent
# state. This layer supplies this fleet's identity, limits and local API.
{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
  readinessCheck = pkgs.writeShellApplication {
    name = "hermes-gateway-readiness";
    runtimeInputs = [
      pkgs.curl
      pkgs.jq
    ];
    text = ''
      until printf 'header = "Authorization: Bearer %s"\n' "$API_SERVER_KEY" |
        curl --silent --fail --noproxy '*' --config - \
          http://127.0.0.1:${toString cfg.api.port}/health/detailed |
        jq --exit-status '.platform == "hermes-agent" and .status == "ok"' >/dev/null; do
        sleep 1
      done
    '';
  };
in
{
  imports = [ inputs.hermes-agent.nixosModules.default ];

  options.my.hermes-agent = {
    enable = lib.mkEnableOption "Hermes Agent on this host";
    user = lib.mkOption {
      type = lib.types.nonEmptyStr;
      default = "hermes";
      description = "Dedicated service identity, separate from OpenClaw.";
    };
    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/hermes";
      description = "Persistent home holding authentication, workspace and Hermes state.";
    };
    home = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${cfg.stateDir}/.hermes";
      description = "HERMES_HOME: config, memory, sessions, skills, cron and plugins.";
    };
    workspace = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default = "${cfg.stateDir}/workspace";
      description = "Working tree for host tasks and coding checkouts.";
    };
    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Tools available to Hermes and its coding subprocesses.";
    };
    api.port = lib.mkOption {
      type = lib.types.port;
      default = 8642;
      description = "Authenticated OpenAI-compatible API, bound to IPv4 loopback only.";
    };
    dashboard = {
      enable = lib.mkEnableOption "the Hermes dashboard backend";
      port = lib.mkOption {
        type = lib.types.port;
        default = 9119;
        description = "Loopback dashboard backend port, optionally exposed through the host web gateway.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/var/lib/" cfg.stateDir;
        message = "my.hermes-agent.stateDir must be a persistent directory below /var/lib/.";
      }
      {
        assertion = cfg.api.port != cfg.dashboard.port;
        message = "Hermes API and dashboard require distinct ports.";
      }
      {
        assertion = !service.container.enable;
        message = "my.hermes-agent supports the native service; container mode requires a separate deployment policy.";
      }
      {
        assertion = service.backend.host == "127.0.0.1";
        message = "my.hermes-agent's dashboard backend must stay on loopback behind the host web gateway.";
      }
    ];

    services.hermes-agent = {
      enable = true;
      package = pkgs.hermes-agent;
      inherit (cfg) user stateDir;
      group = cfg.user;
      workingDirectory = cfg.workspace;
      # Native per-user packages support `sudo -iu hermes hermes ...`
      # without a CLI wrapper or a global HERMES_HOME for other accounts.
      addToSystemPackages = false;
      extraPackages = cfg.extraPackages ++ [
        service.package
        pkgs.bashInteractive
        pkgs.coreutils
        pkgs.curl
        pkgs.ffmpeg-headless
        pkgs.git
        pkgs.jq
        pkgs.python3
        pkgs.ripgrep
        config.nix.package
      ];
      extraArgs = [
        "run"
        "--external-supervisor"
      ];
      environment = {
        API_SERVER_HOST = "127.0.0.1";
        API_SERVER_PORT = toString cfg.api.port;
        GATEWAY_ALLOW_ALL_USERS = "false";
        TELEGRAM_ALLOW_ALL_USERS = "false";
      };
      settings = {
        terminal.backend = "local";
        # Hermes' bounded memory and session search remain mutable on disk.
        memory.memory_enabled = true;
        memory.user_profile_enabled = true;
        platforms.api_server = {
          enabled = true;
          # These take precedence over environment defaults in upstream.
          extra = {
            host = "127.0.0.1";
            port = cfg.api.port;
          };
        };
      };
      backend = {
        mode = if cfg.dashboard.enable then "dashboard" else "none";
        host = "127.0.0.1";
        inherit (cfg.dashboard) port;
      };
    };

    systemd.services.hermes-agent = {
      path = lib.mkBefore [
        "/run/wrappers"
        "/run/current-system/sw"
      ];
      restartTriggers = [
        (pkgs.writeText "hermes-settings.json" (builtins.toJSON service.settings))
        (pkgs.writeText "hermes-documents.json" (
          builtins.toJSON {
            inherit (service) documents hermesHomeFiles environment;
          }
        ))
      ];
      serviceConfig = {
        ExecStartPost = [ (lib.getExe readinessCheck) ];
        UMask = lib.mkForce "0077";
        MemoryMax = "3G";
        TasksMax = 512;
        TimeoutStartSec = 120;
        TimeoutStopSec = 120;
        KillMode = "mixed";
        StandardOutput = "journal";
        StandardError = "journal";
        # Explicit root access opts out of the upstream restrictions that
        # would prevent PAM sudo and host administration from working.
        NoNewPrivileges = lib.mkForce (cfg.root == null);
        ProtectSystem = lib.mkIf (cfg.root != null) (lib.mkForce false);
      };
    };
    systemd.services.hermes-backend = lib.mkIf cfg.dashboard.enable {
      restartTriggers = config.systemd.services.hermes-agent.restartTriggers;
      path = lib.mkBefore [
        "/run/wrappers"
        "/run/current-system/sw"
      ];
      serviceConfig = {
        UMask = lib.mkForce "0077";
        MemoryMax = "1G";
        TasksMax = 256;
        NoNewPrivileges = lib.mkForce (cfg.root == null);
        ProtectSystem = lib.mkIf (cfg.root != null) (lib.mkForce false);
      };
    };

    # Match OpenClaw: the API credential is provisioned once in SOPS.
    my.hermes-agent.secrets.API_SERVER_KEY = "gateway-token";
    systemd.tmpfiles.rules = [
      "d ${cfg.workspace}/tasks 0700 ${cfg.user} ${service.group} - -"
    ];
  };
}
