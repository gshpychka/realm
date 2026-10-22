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
      inherit (cfg) workerPackage;
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
      }
    ) agents;
  };
  catalogFile = (pkgs.formats.json { }).generate "pituitary-agents.json" catalog;
  catalogPath = "/etc/pituitary/agents.json";
  bayCommand = lib.getExe config.services.bay.package;
  package = pkgs.symlinkJoin {
    name = "pituitary-with-agents";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pituitary \
        --set-default PITUITARY_CATALOG ${lib.escapeShellArg catalogPath} \
        --set-default PITUITARY_BAY_COMMAND ${lib.escapeShellArg bayCommand}
    '';
    inherit (cfg.package) meta;
  };
in
{
  imports = [ ./bay.nix ];

  options.services.pituitary = {
    enable = lib.mkEnableOption "Pituitary's declared agent catalog and isolated Bay execution";
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
    workerPackage = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../../packages/pituitary/worker.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ../../../packages/pituitary/worker.nix { }";
      description = "Native worker installed in every agent's NixOS machine.";
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
    ]
    ++ lib.mapAttrsToList (name: agent: {
      assertion = lib.all (target: builtins.hasAttr target cfg.agents) agent.manifest.delegatesTo;
      message = "services.pituitary.agents.${name} delegates to an undeclared agent.";
    }) agents;

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
    environment.systemPackages = [ package ];
    # Home Manager may provide the frontend wrapper. Login defaults let that client
    # discover the same host catalog without duplicating its declarations.
    environment.sessionVariables = {
      PITUITARY_CATALOG = catalogPath;
      PITUITARY_BAY_COMMAND = bayCommand;
    };
  };
}
