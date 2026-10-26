# The agent's secrets: sops values in the environment Hermes loads from
# HERMES_HOME/.env at start.
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
  # sops-nix secret names are host-global, so each of sopsFile's carries the service name
  sopsName = key: "hermes-agent/${key}";
  envFile = "hermes-agent.env";
  # each variable's sops-nix secret; a host secret is named for its key
  secretNames = lib.mapAttrs (_: sopsName) cfg.secrets // cfg.hostSecrets;
in
{
  options.my.hermes-agent = {
    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = "SOPS file holding the agent's secrets.";
    };

    secrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.nonEmptyStr;
      default = { };
      example = {
        OPENAI_API_KEY = "openai-api-key";
      };
      description = "Environment variables of the agent, each set from the named sopsFile key: a token free of whitespace, quotes and backslashes.";
    };

    hostSecrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.nonEmptyStr;
      default = { };
      example = {
        TELEGRAM_ALLOWED_USERS = "telegram-owner-id";
      };
      description = "Environment variables of the agent, each set from the named key of this host's default sops file, which the host's other services share: a token free of whitespace, quotes and backslashes.";
    };
  };

  config = lib.mkIf service.enable {
    assertions = [
      {
        assertion = builtins.intersectAttrs cfg.secrets cfg.hostSecrets == { };
        message = "my.hermes-agent.secrets and my.hermes-agent.hostSecrets set the same variables: ${toString (lib.attrNames (builtins.intersectAttrs cfg.secrets cfg.hostSecrets))}.";
      }
    ];

    sops = {
      secrets =
        lib.mapAttrs' (
          _: key:
          lib.nameValuePair (sopsName key) {
            inherit (cfg) sopsFile;
            inherit key;
          }
        ) cfg.secrets
        # each from the host's default sops file, under its key's name
        // lib.genAttrs (lib.attrValues cfg.hostSecrets) (_: { });
      templates.${envFile} = {
        content = lib.concatLines (
          lib.mapAttrsToList (var: name: "${var}=${config.sops.placeholder.${name}}") secretNames
        );
        restartUnits = map (unit: config.systemd.services.${unit}.name) cfg.units;
      };
    };

    # activation copies it into HERMES_HOME/.env, after sops-nix renders it
    services.hermes-agent.environmentFiles = [ config.sops.templates.${envFile}.path ];
  };
}
