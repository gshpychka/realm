# Named agents are ordinary NixOS modules; their roles travel separately from their images.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.dura;
  inherit (lib) mkOption types;
  evaluate = import ../../../packages/dura/agent.nix;
  agents = lib.mapAttrs (
    name: module:
    evaluate {
      inherit name pkgs;
      bay = config.services.bay.package;
      incus = config.virtualisation.incus.package;
      modules = [ module ];
    }
  ) cfg.agents;
  machineFor =
    agent:
    agent.image
    // {
      resources = {
        inherit (config.services.bay.sessions) cpus memory disk;
      };
    };
  machineIdentity = agent: import ../../../packages/bay/machine.nix (machineFor agent);
  machineName = agent: "dura-${builtins.substring 0 32 (machineIdentity agent).revision}";
  catalog = {
    schemaVersion = 1;
    baySocket = "/run/bay/bay.sock";
    agents = lib.mapAttrs (
      name: agent:
      agent.manifest
      // {
        program = "dura-${name}";
        machine = machineName agent;
        machineRevision = (machineIdentity agent).revision;
        inherit (agent) verification;
      }
    ) agents;
  };
  catalogFile = (pkgs.formats.json { }).generate "dura-agents.json" catalog;
  catalogPath = "/etc/dura/agents.json";
  credentialProfilesPath = "/etc/dura/credentials.json";
  credentialProfilesFile =
    (pkgs.formats.json { }).generate "dura-credentials.json"
      cfg.credentialProfiles;
  package = pkgs.symlinkJoin {
    name = "dura-with-agents";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/dura \
        --set-default DURA_CATALOG ${lib.escapeShellArg catalogPath} \
        --set-default DURA_STATE_DIR ${lib.escapeShellArg cfg.stateDirectory} \
        --set DURA_AUTO_START 0 \
        --set-default DURA_AUTH_FILE ${lib.escapeShellArg cfg.authFile} \
        --set-default DURA_CREDENTIAL_PROFILES ${lib.escapeShellArg credentialProfilesPath} \
        --set-default DURA_RUN_LIMITS ${lib.escapeShellArg (builtins.toJSON cfg.limits)}
    '';
    inherit (cfg.package) meta;
  };
in
{
  imports = [ ./bay.nix ];

  options.services.dura = {
    enable = lib.mkEnableOption "Dura's durable host runtime and declared Bay agents";
    operator = mkOption {
      type = types.str;
      description = "The operator who runs Dura and owns Bay's local API access.";
    };
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../../packages/dura { };
      defaultText = lib.literalExpression "pkgs.callPackage ../../../packages/dura { }";
      description = "Dura client configured to use this host's declared agents.";
    };
    stateDirectory = mkOption {
      type = types.strMatching "/.*";
      default = "/var/lib/dura";
      description = "Private durable host state. CLI clients discover the runtime through this same directory.";
    };
    model = mkOption {
      type = types.nullOr (types.strMatching "[^/[:space:]]+/[^[:space:]]+");
      default = null;
      example = "anthropic/your-model";
      description = "Host default model for agents whose model is null. Explicit agent models take precedence.";
    };
    limits = {
      maxTasks = mkOption {
        type = types.ints.positive;
        default = 16;
        description = "Maximum tasks created in one run, including cancelled tasks.";
      };
      maxLiveAttempts = mkOption {
        type = types.ints.positive;
        default = 4;
        description = "Maximum live attempts per run, including waiting or unreachable environments.";
      };
      maxDepth = mkOption {
        type = types.ints.unsigned;
        default = 2;
        description = "Maximum task depth below the root coordinator.";
      };
      deadlineMs = mkOption {
        type = types.ints.positive;
        default = 3600000;
        description = "Run deadline in milliseconds from creation.";
      };
      reportBytes = mkOption {
        type = types.ints.between 1 65536;
        default = 65536;
        description = "Maximum UTF-8 bytes in a submitted report.";
      };
      artifactBytes = mkOption {
        type = types.ints.between 1 134217728;
        default = 67108864;
        description = "Maximum bytes in one retained Git artifact bundle.";
      };
    };
    authFile = mkOption {
      type = types.addCheck (types.strMatching "/.*") (
        value: value != builtins.storeDir && !lib.hasPrefix "${builtins.storeDir}/" value
      );
      default = "${config.users.users.${cfg.operator}.home}/.pi/agent/auth.json";
      defaultText = "The operator's ~/.pi/agent/auth.json";
      description = ''
        Pi's shared provider auth file. Sign in through Pituitary's /login; Pi's native
        credential store owns token refresh and file locking. This path stays on the
        host and must be writable by the operator for OAuth refresh.
      '';
    };
    credentialProfiles = mkOption {
      default = { };
      type = types.attrsOf (
        types.submodule {
          options = {
            provider = mkOption {
              type = types.strMatching "[a-zA-Z0-9_.-]+";
              description = "Pi provider this named profile grants an agent access to.";
            };
          };
        }
      );
      description = "Named provider grants available to agent roles. Credentials remain in the shared host authFile.";
    };
    agents = mkOption {
      type = types.attrsOf types.deferredModule;
      default = { };
      description = ''
        Named agents, each an ordinary NixOS module with imports, system packages, services, and dura.agent
        role metadata. Equal machines share an image; role edits do not rebuild it.
      '';
    };
    catalogFile = mkOption {
      type = types.path;
      readOnly = true;
      description = "Resolved runtime catalog containing roles and their Bay program and machine names.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.bay.enable;
        message = "services.dura requires services.bay.enable.";
      }
      {
        assertion = config.services.bay.operator == cfg.operator;
        message = "services.dura and services.bay must use the same operator.";
      }
      {
        assertion = lib.all (name: builtins.match "[a-zA-Z0-9][a-zA-Z0-9_.-]*" name != null) (
          builtins.attrNames cfg.credentialProfiles
        );
        message = "services.dura.credentialProfiles names must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens.";
      }
      {
        assertion =
          let
            providers = map (profile: profile.provider) (builtins.attrValues cfg.credentialProfiles);
          in
          lib.unique providers == providers;
        message = "services.dura.credentialProfiles must declare one profile per provider.";
      }
    ]
    ++ lib.concatLists (
      lib.mapAttrsToList (name: agent: [
        {
          assertion = lib.all (target: builtins.hasAttr target cfg.agents) agent.manifest.delegatesTo;
          message = "services.dura.agents.${name} delegates to an undeclared agent.";
        }
        {
          assertion = agent.verification == null || builtins.hasAttr agent.verification.agent agents;
          message = "services.dura.agents.${name} verifies with an undeclared agent.";
        }
        {
          assertion = lib.all (
            profile: builtins.hasAttr profile cfg.credentialProfiles
          ) agent.manifest.credentials;
          message = "services.dura.agents.${name} requests an undeclared credential profile.";
        }
      ]) agents
    );

    services.dura.catalogFile = catalogFile;
    services.bay = {
      enable = lib.mkDefault true;
      operator = lib.mkDefault cfg.operator;
      machines = lib.listToAttrs (
        lib.mapAttrsToList (_: agent: {
          name = machineName agent;
          value = machineFor agent;
        }) agents
      );
      programs = lib.mapAttrs' (
        name: agent: lib.nameValuePair "dura-${name}" (agent.program // { machine = machineName agent; })
      ) agents;
    };
    environment.etc."dura/agents.json".source = catalogFile;
    environment.etc."dura/credentials.json".source = credentialProfilesFile;
    environment.systemPackages = [ package ];
    # Home Manager may provide the frontend wrapper. Login defaults let that client
    # discover the same host catalog without duplicating its declarations.
    environment.sessionVariables = {
      DURA_CATALOG = catalogPath;
      DURA_STATE_DIR = cfg.stateDirectory;
      DURA_AUTO_START = "0";
      DURA_AUTH_FILE = cfg.authFile;
      DURA_CREDENTIAL_PROFILES = credentialProfilesPath;
    };
    systemd.tmpfiles.rules = [ "d ${cfg.stateDirectory} 0700 ${cfg.operator} - -" ];
    systemd.services.dura = {
      description = "Dura host runtime";
      wantedBy = [ "multi-user.target" ];
      after = [
        "bay-server.service"
        "bay-base.service"
      ];
      requires = [ "bay-base.service" ];
      wants = [ "bay-server.service" ];
      restartTriggers = [
        catalogFile
        credentialProfilesFile
      ];
      environment = {
        DURA_CATALOG = catalogPath;
        DURA_STATE_DIR = cfg.stateDirectory;
        DURA_AUTH_FILE = cfg.authFile;
        DURA_CREDENTIAL_PROFILES = credentialProfilesPath;
        DURA_RUN_LIMITS = builtins.toJSON cfg.limits;
      }
      // lib.optionalAttrs (cfg.model != null) { DURA_MODEL = cfg.model; };
      serviceConfig = {
        User = cfg.operator;
        UMask = "0077";
        ExecStart = lib.escapeShellArgs [
          "${package}/bin/dura"
          "serve"
          "--state"
          cfg.stateDirectory
          "--catalog"
          catalogPath
        ];
        Restart = "on-failure";
        RestartSec = 2;
      };
    };
  };
}
