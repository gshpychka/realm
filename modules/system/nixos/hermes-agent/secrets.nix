# The agent's secrets: sopsFile values in the environment Hermes loads from
# HERMES_HOME/.env at start.
{ config, lib, ... }:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;
  # sops-nix secret names are host-global, so each carries the service name
  sopsName = key: "hermes-agent/${key}";
  envFile = "hermes-agent.env";
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
  };

  config = lib.mkIf service.enable {
    sops = {
      secrets = lib.mapAttrs' (
        _: key:
        lib.nameValuePair (sopsName key) {
          inherit (cfg) sopsFile;
          inherit key;
        }
      ) cfg.secrets;
      templates.${envFile} = {
        content = lib.concatLines (
          lib.mapAttrsToList (var: key: "${var}=${config.sops.placeholder.${sopsName key}}") cfg.secrets
        );
        restartUnits = map (unit: config.systemd.services.${unit}.name) cfg.units;
      };
    };

    # activation copies it into HERMES_HOME/.env, after sops-nix renders it
    services.hermes-agent.environmentFiles = [ config.sops.templates.${envFile}.path ];
  };
}
