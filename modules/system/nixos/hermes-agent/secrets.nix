# Reuse encrypted values by key; no plaintext credential enters the store.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hermes-agent;
  sopsName = key: "hermes/${key}";
  service = config.services.hermes-agent;
  base = pkgs.writeText "hermes-environment.json" (builtins.toJSON service.environment);
  refreshEnvironment = ''
    ${lib.getExe pkgs.python3} ${../../../../scripts/hermes-agent/runtime.py} sync-environment \
      --credential ${lib.escapeShellArg "${cfg.home}/api.env"} \
      --destination ${lib.escapeShellArg "${cfg.home}/.env"} --base ${base} \
      ${lib.concatMapStringsSep " " (file: "--source=${lib.escapeShellArg file}") (
        service.environmentFiles ++ cfg.environmentFiles
      )}
  '';
in
{
  options.my.hermes-agent = {
    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = "SOPS source for reusable model, messaging and integration credentials.";
    };
    secrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.nonEmptyStr;
      default = { };
      description = "Environment variable to encrypted SOPS key mapping; values must be single-line tokens.";
    };
    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional runtime environment files; prefix optional systemd files with -. Never use Nix path literals for secrets.";
    };
    telegram.enable = lib.mkEnableOption "owner-only Telegram DMs (requires its own bot token)";
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.mapAttrsToList (name: _: {
      assertion = builtins.match "[A-Z][A-Z0-9_]*" name != null;
      message = "my.hermes-agent.secrets requires uppercase environment variable names.";
    }) cfg.secrets;

    sops = {
      secrets = lib.mapAttrs' (
        _: key:
        lib.nameValuePair (sopsName key) {
          inherit (cfg) sopsFile;
          inherit key;
        }
      ) cfg.secrets;
      templates."hermes.env" = {
        owner = cfg.user;
        mode = "0400";
        content = lib.concatLines (
          lib.mapAttrsToList (name: key: "${name}=${config.sops.placeholder.${sopsName key}}") cfg.secrets
        );
        restartUnits = [
          "hermes-agent.service"
        ]
        ++ lib.optional cfg.dashboard.enable "hermes-backend.service";
      };
    };

    services.hermes-agent.environmentFiles = [ config.sops.templates."hermes.env".path ];
    # Hermes loads .env with override=True and clears missing known keys.
    # Refresh it after key creation on every start, including bot-only changes.
    systemd.services.hermes-agent.preStart = lib.mkAfter refreshEnvironment;
    systemd.services.hermes-backend = lib.mkIf cfg.dashboard.enable {
      preStart = refreshEnvironment;
    };

    # settings is upstream's custom deep-merge type: mkIf must wrap the
    # option definition, otherwise it is serialized into config.yaml.
    services.hermes-agent.settings = lib.mkIf cfg.telegram.enable {
      platforms.telegram = {
        enabled = true;
        extra = {
          dm_policy = "allowlist";
          group_policy = "disabled";
          # The Telegram adapter enforces this empty list, rather than the
          # generic group_policy hint, to reject every group sender.
          group_allow_from = [ ];
          unauthorized_dm_behavior = "ignore";
        };
      };
    };
  };
}
