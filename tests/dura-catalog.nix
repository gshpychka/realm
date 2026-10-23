# Host catalog conformance: evaluate NixOS guests, build only small JSON files and client wrappers.
{ pkgs }:
let
  inherit (pkgs) lib;
  bayPackage = (pkgs.writeShellScriptBin "bay" "exit 0") // {
    flare = pkgs.writeShellScriptBin "flare" "exit 0";
    guestTools = pkgs.writeShellScriptBin "bay-guest" "exit 0";
  };
  clientPackage = pkgs.writeShellScriptBin "dura" ''
    printf '%s\n' "$DURA_CATALOG"
  '';
  common = { pkgs, ... }: {
    environment.systemPackages = [ pkgs.ripgrep ];
  };
  host = pkgs.nixos {
    imports = [ ../modules/system/nixos/dura.nix ];
    system.stateVersion = "26.05";
    users.users.alice.isNormalUser = true;
    services.bay = {
      package = bayPackage;
      network.address = "10.80.0.1/24";
      sessions = {
        cpus = 1;
        memory = 1;
        disk = 6;
        maxRunning = 2;
      };
    };
    services.dura = {
      enable = true;
      operator = "alice";
      model = "anthropic/example-model";
      package = clientPackage;
      credentialProfiles.primary = {
        provider = "anthropic";
      };
      agents = {
        builder = {
          imports = [ common ];
          dura.agent = {
            instructions = "Implement one reviewed result.";
            delegatesTo = [ "reviewer" ];
            credentials = [ "primary" ];
            limits = {
              maxChildren = 2;
              maxDepth = 1;
            };
            verification = {
              agent = "reviewer";
              checks.unit.command = [ "true" ];
            };
          };
        };
        reviewer = {
          imports = [ common ];
          dura.agent = {
            instructions = "Review the exact result.";
            tools = [
              "read"
              "grep"
            ];
          };
        };
        data = { pkgs, ... }: {
          imports = [ common ];
          environment.systemPackages = [ pkgs.jq ];
        };
      };
    };
  };
  cfg = host.config;
  disabled =
    (pkgs.nixos {
      imports = [ ../modules/system/nixos/dura.nix ];
      system.stateVersion = "26.05";
    }).config;
  roleEdited =
    (host.extendModules {
      modules = [
        {
          services.dura.agents.builder.dura.agent.instructions = lib.mkForce "Different role.";
        }
      ];
    }).config;
  resourceEdited =
    (host.extendModules {
      modules = [ { services.bay.sessions.memory = lib.mkForce 2; } ];
    }).config;
  verificationEdited =
    (host.extendModules {
      modules = [
        {
          services.dura.agents.builder.dura.agent.verification.checks.unit.command = lib.mkForce [
            "false"
          ];
        }
      ];
    }).config;
  invalid =
    (host.extendModules {
      modules = [
        {
          services.dura.agents.builder.dura.agent.delegatesTo = lib.mkForce [ "missing" ];
        }
      ];
    }).config;
  machineName = config: config.services.bay.programs.dura-builder.machine;
  machine = config: config.services.bay.machines.${machineName config};
  client = lib.findFirst (
    package: package.name == "dura-with-agents"
  ) (throw "Dura host client is not installed") cfg.environment.systemPackages;
  # The server configuration names bases and programs, not image artifacts, so reading
  # it does not force a guest image build either.
  serverConfig = builtins.elemAt (lib.splitString " " cfg.systemd.services.bay-server.serviceConfig.ExecStart) 2;
  checks = {
    disabledIsLazy =
      !disabled.services.dura.enable
      && !disabled.services.bay.enable
      && !builtins.hasAttr "dura/agents.json" disabled.environment.etc
      && !builtins.hasAttr "DURA_CATALOG" disabled.environment.sessionVariables;
    enablesBay = cfg.services.bay.enable && cfg.services.bay.operator == "alice";
    sharedMachine = machineName cfg == cfg.services.bay.programs.dura-reviewer.machine;
    distinctMachine = machineName cfg != cfg.services.bay.programs.dura-data.machine;
    machineCount = builtins.length (builtins.attrNames cfg.services.bay.machines) == 3;
    baseCount = builtins.length cfg.systemd.services.bay-base.serviceConfig.ExecStart == 3;
    roleIndependentBases =
      cfg.systemd.services.bay-base.serviceConfig.ExecStart
      == roleEdited.systemd.services.bay-base.serviceConfig.ExecStart;
    distinctRoleCatalog =
      toString cfg.services.dura.catalogFile != toString roleEdited.services.dura.catalogFile;
    resourceIdentity = machineName cfg != machineName resourceEdited;
    resourceIndependentImage = (machine cfg).disk == (machine resourceEdited).disk;
    executionShell =
      cfg.services.bay.programs.dura-builder.command == [ "${pkgs.bashInteractive}/bin/bash" ];
    verificationIndependentImage = (machine cfg).disk == (machine verificationEdited).disk;
    verificationChangesCatalog =
      toString cfg.services.dura.catalogFile
      != toString verificationEdited.services.dura.catalogFile;
    verificationOutsideRole =
      !(builtins.hasAttr "verification"
        (import ../packages/dura/agent.nix {
          name = "separate";
          inherit pkgs;
          bay = bayPackage;
          modules = [
            {
              dura.agent.verification = {
                agent = "reviewer";
                checks.test.command = [ "true" ];
              };
            }
          ];
        }).manifest
      );
    hostOwnsConversations = !(cfg.services.bay.programs.dura-builder ? connect);
    memoryBudget = cfg.services.bay.sessions.maxMemory == 2;
    stableCatalogPath =
      cfg.environment.sessionVariables.DURA_CATALOG == "/etc/dura/agents.json";
    daemonOperator = cfg.systemd.services.dura.serviceConfig.User == "alice";
    daemonModel =
      cfg.systemd.services.dura.environment.DURA_MODEL == "anthropic/example-model";
    daemonState = cfg.environment.sessionVariables.DURA_STATE_DIR == "/var/lib/dura";
    managedClients = cfg.environment.sessionVariables.DURA_AUTO_START == "0";
    preparedMachines =
      builtins.elem "bay-base.service" cfg.systemd.services.dura.after
      && builtins.elem "bay-base.service" cfg.systemd.services.dura.requires;
    credentialReference =
      cfg.systemd.services.dura.environment.DURA_CREDENTIAL_PROFILES
      == "/etc/dura/credentials.json";
    sharedPiAuth =
      cfg.systemd.services.dura.environment.DURA_AUTH_FILE == "/home/alice/.pi/agent/auth.json"
      && cfg.environment.sessionVariables.DURA_AUTH_FILE == "/home/alice/.pi/agent/auth.json";
    limitsDeclared =
      cfg.services.dura.limits.maxTasks == 16 && cfg.services.dura.limits.reportBytes == 65536;
    unknownDelegation = lib.any (
      check: !check.assertion && lib.hasPrefix "services.dura.agents.builder" check.message
    ) invalid.assertions;
  };
  failed = lib.attrNames (lib.filterAttrs (_: passed: !passed) checks);
in
assert lib.assertMsg (
  failed == [ ]
) "Dura catalog evaluation failed: ${lib.concatStringsSep ", " failed}";
pkgs.runCommand "dura-catalog-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
  catalog=${cfg.services.dura.catalogFile}
  jq -e '.schemaVersion == 1 and .baySocket == "/run/bay/bay.sock"
    and .agents.builder.name == "builder" and .agents.builder.program == "dura-builder"
    and .agents.builder.delegatesTo == ["reviewer"] and .agents.builder.credentials == ["primary"]
    and .agents.builder.limits == {maxChildren: 2, maxDepth: 1} and .agents.reviewer.tools == ["read", "grep"]
    and .agents.builder.verification == {agent: "reviewer", checks: {unit: {command: ["true"], timeoutMs: 300000}}}' \
    "$catalog" >/dev/null
  jq -e --slurpfile catalog "$catalog" '. as $server | $catalog[0].agents.builder.machine as $machine
    | $server.programs["dura-builder"].machine == $machine
    and $server.machines[$machine].revision == $catalog[0].agents.builder.machineRevision
    and ($server.machines[$machine].base | startswith("bay-base-"))
    and $server.machines[$machine].resources == {cpus: 1, memory: 1, disk: 6}
    and $server.maxMemory == 2' ${serverConfig} >/dev/null
  test "$(${client}/bin/dura)" = /etc/dura/agents.json
  cp ${pkgs.writeText "dura-catalog-checks.json" (builtins.toJSON checks)} "$out"
''
