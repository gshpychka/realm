# The gateway's secrets: sops values set as environment variables of its
# process, which openclaw.json references by name.
{ config, lib, ... }:
let
  cfg = config.my.openclaw;
  gw = config.services.openclaw-gateway;
  # sops-nix secret names are host-global, so each of sopsFile's carries the service name
  sopsName = key: "openclaw/${key}";
  envFile = "openclaw.env";
  # each variable's sops-nix secret; a host secret is named for its key
  secretNames = lib.mapAttrs (_: sopsName) cfg.secrets // cfg.hostSecrets;
in
{
  options.my.openclaw = {
    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = "SOPS file holding the gateway's secrets.";
    };

    secrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.nonEmptyStr;
      default = { };
      example = {
        OPENAI_API_KEY = "openai-api-key";
      };
      description = "Environment variables of the gateway's process, each set from the named sopsFile key: a token free of whitespace, quotes and backslashes.";
    };

    hostSecrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.nonEmptyStr;
      default = { };
      example = {
        TELEGRAM_OWNER_ID = "telegram-owner-id";
      };
      description = "Environment variables of the gateway's process, each set from the named key of this host's default sops file, which the host's other services share: a token free of whitespace, quotes and backslashes.";
    };

    secretVars = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      default = lib.mapAttrs (var: _: "\${${var}}") secretNames;
      description = "Each secret as the \${NAME} substitution a string of openclaw.json takes (https://docs.openclaw.ai/gateway/config-secrets-env), keyed by variable name.";
    };

    secretRefs = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.str);
      readOnly = true;
      default = lib.mapAttrs (var: _: {
        source = "env";
        provider = "default";
        id = var;
      }) secretNames;
      description = "Each secret as the env SecretRef (https://docs.openclaw.ai/gateway/secrets/secretref-contract) a credential field of openclaw.json takes, keyed by variable name.";
    };

    secretFiles = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      default = lib.mapAttrs (_: name: config.sops.secrets.${name}.path) secretNames;
      description = "Each secret's file, readable by root only, keyed by variable name.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = builtins.intersectAttrs cfg.secrets cfg.hostSecrets == { };
        message = "my.openclaw.secrets and my.openclaw.hostSecrets set the same variables: ${toString (lib.attrNames (builtins.intersectAttrs cfg.secrets cfg.hostSecrets))}.";
      }
    ]
    ++ lib.mapAttrsToList (var: _: {
      assertion = builtins.match "[A-Z][A-Z0-9_]{0,127}" var != null;
      message = "my.openclaw secret variable ${var}: OpenClaw reads only variable names matching [A-Z][A-Z0-9_]{0,127}.";
    }) secretNames;

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
        # the gateway user reads it directly
        owner = gw.user;
        restartUnits = [ config.systemd.services.${gw.unitName}.name ];
      };
    };

    services.openclaw-gateway.environmentFiles = [ config.sops.templates.${envFile}.path ];
  };
}
