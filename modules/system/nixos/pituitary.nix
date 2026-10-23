# Named agents are ordinary NixOS modules; their roles travel separately from their images.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.pituitary;
  inherit (lib) mkOption types;
  evaluate = import ../../../packages/pituitary/agent.nix;
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
  machineName = agent: "pituitary-${builtins.substring 0 32 (machineIdentity agent).revision}";
  catalog = {
    schemaVersion = 1;
    baySocket = "/run/bay/bay.sock";
    agents = lib.mapAttrs (
      name: agent:
      agent.manifest
      // {
        program = "pituitary-${name}";
        machine = machineName agent;
        machineRevision = (machineIdentity agent).revision;
        inherit (agent) verification;
      }
    ) agents;
  };
  catalogFile = (pkgs.formats.json { }).generate "pituitary-agents.json" catalog;
  catalogPath = "/etc/pituitary/agents.json";
  credentialProfilesPath = "/etc/pituitary/credentials.json";
  credentialProfilesFile =
    (pkgs.formats.json { }).generate "pituitary-credentials.json"
      cfg.credentialProfiles;
  package = pkgs.symlinkJoin {
    name = "pituitary-with-agents";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pituitary \
        --set-default PITUITARY_CATALOG ${lib.escapeShellArg catalogPath} \
        --set-default PITUITARY_STATE_DIR ${lib.escapeShellArg cfg.stateDirectory} \
        --set PITUITARY_AUTO_START 0 \
        --set-default PITUITARY_CREDENTIAL_PROFILES ${lib.escapeShellArg credentialProfilesPath} \
        --set-default PITUITARY_RUN_LIMITS ${lib.escapeShellArg (builtins.toJSON cfg.limits)}
    '';
    inherit (cfg.package) meta;
  };
in
{
  imports = [ ./bay.nix ];

  options.services.pituitary = {
    enable = lib.mkEnableOption "Pituitary's durable host runtime and declared Bay agents";
    operator = mkOption {
      type = types.str;
      description = "The operator who runs Pituitary and owns Bay's local API access.";
    };
    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../../packages/pituitary { };
      defaultText = lib.literalExpression "pkgs.callPackage ../../../packages/pituitary { }";
      description = "Pituitary client configured to use this host's declared agents.";
    };
    stateDirectory = mkOption {
      type = types.strMatching "/.*";
      default = "/var/lib/pituitary";
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
    credentialProfiles = mkOption {
      default = { };
      type = types.attrsOf (
        types.submodule {
          options = {
            provider = mkOption {
              type = types.strMatching "[a-zA-Z0-9_.-]+";
              description = "Pi provider receiving this API key.";
            };
            file = mkOption {
              type = types.addCheck types.str (
                value: lib.hasPrefix "/" value && !lib.hasPrefix "${builtins.storeDir}/" value
              );
              description = "Absolute runtime file containing the API key. Nix store paths are forbidden.";
            };
          };
        }
      );
      description = "Named provider API keys. Only runtime file references enter generated host configuration.";
    };
    agents = mkOption {
      type = types.attrsOf types.deferredModule;
      default = { };
      description = ''
        Named agents, each an ordinary NixOS module with imports, system packages, services, and pituitary.agent
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
        message = "services.pituitary requires services.bay.enable.";
      }
      {
        assertion = config.services.bay.operator == cfg.operator;
        message = "services.pituitary and services.bay must use the same operator.";
      }
      {
        assertion = lib.all (name: builtins.match "[a-zA-Z0-9][a-zA-Z0-9_.-]*" name != null) (
          builtins.attrNames cfg.credentialProfiles
        );
        message = "services.pituitary.credentialProfiles names must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens.";
      }
      {
        assertion =
          let
            providers = map (profile: profile.provider) (builtins.attrValues cfg.credentialProfiles);
          in
          lib.unique providers == providers;
        message = "services.pituitary.credentialProfiles must declare one profile per provider.";
      }
    ]
    ++ lib.concatLists (
      lib.mapAttrsToList (name: agent: [
        {
          assertion = lib.all (target: builtins.hasAttr target cfg.agents) agent.manifest.delegatesTo;
          message = "services.pituitary.agents.${name} delegates to an undeclared agent.";
        }
        {
          assertion = agent.verification == null || builtins.hasAttr agent.verification.agent agents;
          message = "services.pituitary.agents.${name} verifies with an undeclared agent.";
        }
        {
          assertion = lib.all (
            profile: builtins.hasAttr profile cfg.credentialProfiles
          ) agent.manifest.credentials;
          message = "services.pituitary.agents.${name} requests an undeclared credential profile.";
        }
      ]) agents
    );

    services.pituitary.catalogFile = catalogFile;
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
        name: agent:
        lib.nameValuePair "pituitary-${name}" (agent.program // { machine = machineName agent; })
      ) agents;
    };
    environment.etc."pituitary/agents.json".source = catalogFile;
    environment.etc."pituitary/credentials.json".source = credentialProfilesFile;
    environment.systemPackages = [ package ];
    # Home Manager may provide the frontend wrapper. Login defaults let that client
    # discover the same host catalog without duplicating its declarations.
    environment.sessionVariables = {
      PITUITARY_CATALOG = catalogPath;
      PITUITARY_STATE_DIR = cfg.stateDirectory;
      PITUITARY_AUTO_START = "0";
      PITUITARY_CREDENTIAL_PROFILES = credentialProfilesPath;
      PITUITARY_RUN_LIMITS = builtins.toJSON cfg.limits;
    };
    systemd.tmpfiles.rules = [ "d ${cfg.stateDirectory} 0700 ${cfg.operator} - -" ];
    systemd.services.pituitary = {
      description = "Pituitary host runtime";
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
        PITUITARY_CATALOG = catalogPath;
        PITUITARY_STATE_DIR = cfg.stateDirectory;
        PITUITARY_CREDENTIAL_PROFILES = credentialProfilesPath;
        PITUITARY_RUN_LIMITS = builtins.toJSON cfg.limits;
      }
      // lib.optionalAttrs (cfg.model != null) { PITUITARY_MODEL = cfg.model; };
      serviceConfig = {
        User = cfg.operator;
        UMask = "0077";
        ExecStart = lib.escapeShellArgs [
          "${package}/bin/pituitary"
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
