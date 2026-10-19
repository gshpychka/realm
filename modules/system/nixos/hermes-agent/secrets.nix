# Reuse encrypted values by key; no plaintext credential enters the store.
{
  config,
  lib,
  ...
}:
let
  cfg = config.my.hermes-agent;
  sopsName = key: "hermes/${key}";
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

    # Native activation copies this file after setupSecrets. Rebuild to apply
    # credential changes; systemd also supplies it to the readiness command.
    services.hermes-agent.environmentFiles = [ config.sops.templates."hermes.env".path ];
    systemd.services.hermes-agent.serviceConfig.EnvironmentFile = [
      config.sops.templates."hermes.env".path
    ];

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
