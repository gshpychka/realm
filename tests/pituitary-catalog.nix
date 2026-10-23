# Host catalog conformance: evaluate NixOS guests, build only small JSON files and client wrappers.
{ pkgs }:
let
  inherit (pkgs) lib;
  bayPackage = (pkgs.writeShellScriptBin "bay" "exit 0") // {
    flare = pkgs.writeShellScriptBin "flare" "exit 0";
    guestTools = pkgs.writeShellScriptBin "bay-guest" "exit 0";
  };
  clientPackage = pkgs.writeShellScriptBin "pituitary" ''
    printf '%s\n' "$PITUITARY_CATALOG"
  '';
  common = { pkgs, ... }: {
    environment.systemPackages = [ pkgs.ripgrep ];
  };
  host = pkgs.nixos {
    imports = [ ../modules/system/nixos/pituitary.nix ];
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
    services.pituitary = {
      enable = true;
      operator = "alice";
      model = "anthropic/example-model";
      package = clientPackage;
      credentialProfiles.primary = {
        provider = "anthropic";
        file = "/run/secrets/pituitary-api-key";
      };
      agents = {
        builder = {
          imports = [ common ];
          pituitary.agent = {
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
          pituitary.agent = {
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
      imports = [ ../modules/system/nixos/pituitary.nix ];
      system.stateVersion = "26.05";
    }).config;
  roleEdited =
    (host.extendModules {
      modules = [
        {
          services.pituitary.agents.builder.pituitary.agent.instructions = lib.mkForce "Different role.";
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
          services.pituitary.agents.builder.pituitary.agent.verification.checks.unit.command = lib.mkForce [
            "false"
          ];
        }
      ];
    }).config;
  invalid =
    (host.extendModules {
      modules = [
        {
          services.pituitary.agents.builder.pituitary.agent.delegatesTo = lib.mkForce [ "missing" ];
        }
      ];
    }).config;
  machineName = config: config.services.bay.programs.pituitary-builder.machine;
  machine = config: config.services.bay.machines.${machineName config};
  client = lib.findFirst (
    package: package.name == "pituitary-with-agents"
  ) (throw "Pituitary host client is not installed") cfg.environment.systemPackages;
  # The server configuration names bases and programs, not image artifacts, so reading
  # it does not force a guest image build either.
  serverConfig = builtins.elemAt (lib.splitString " " cfg.systemd.services.bay-server.serviceConfig.ExecStart) 2;
  checks = {
    disabledIsLazy =
      !disabled.services.pituitary.enable
      && !disabled.services.bay.enable
      && !builtins.hasAttr "pituitary/agents.json" disabled.environment.etc
      && !builtins.hasAttr "PITUITARY_CATALOG" disabled.environment.sessionVariables;
    enablesBay = cfg.services.bay.enable && cfg.services.bay.operator == "alice";
    sharedMachine = machineName cfg == cfg.services.bay.programs.pituitary-reviewer.machine;
    distinctMachine = machineName cfg != cfg.services.bay.programs.pituitary-data.machine;
    machineCount = builtins.length (builtins.attrNames cfg.services.bay.machines) == 3;
    baseCount = builtins.length cfg.systemd.services.bay-base.serviceConfig.ExecStart == 3;
    roleIndependentBases =
      cfg.systemd.services.bay-base.serviceConfig.ExecStart
      == roleEdited.systemd.services.bay-base.serviceConfig.ExecStart;
    distinctRoleCatalog =
      toString cfg.services.pituitary.catalogFile != toString roleEdited.services.pituitary.catalogFile;
    resourceIdentity = machineName cfg != machineName resourceEdited;
    resourceIndependentImage = (machine cfg).disk == (machine resourceEdited).disk;
    executionShell =
      cfg.services.bay.programs.pituitary-builder.command == [ "${pkgs.bashInteractive}/bin/bash" ];
    verificationIndependentImage = (machine cfg).disk == (machine verificationEdited).disk;
    verificationChangesCatalog =
      toString cfg.services.pituitary.catalogFile
      != toString verificationEdited.services.pituitary.catalogFile;
    verificationOutsideRole =
      !(builtins.hasAttr "verification"
        (import ../packages/pituitary/agent.nix {
          name = "separate";
          inherit pkgs;
          bay = bayPackage;
          modules = [
            {
              pituitary.agent.verification = {
                agent = "reviewer";
                checks.test.command = [ "true" ];
              };
            }
          ];
        }).manifest
      );
    hostOwnsConversations = !(cfg.services.bay.programs.pituitary-builder ? connect);
    memoryBudget = cfg.services.bay.sessions.maxMemory == 2;
    stableCatalogPath =
      cfg.environment.sessionVariables.PITUITARY_CATALOG == "/etc/pituitary/agents.json";
    daemonOperator = cfg.systemd.services.pituitary.serviceConfig.User == "alice";
    daemonModel =
      cfg.systemd.services.pituitary.environment.PITUITARY_MODEL == "anthropic/example-model";
    daemonState = cfg.environment.sessionVariables.PITUITARY_STATE_DIR == "/var/lib/pituitary";
    managedClients = cfg.environment.sessionVariables.PITUITARY_AUTO_START == "0";
    preparedMachines =
      builtins.elem "bay-base.service" cfg.systemd.services.pituitary.after
      && builtins.elem "bay-base.service" cfg.systemd.services.pituitary.requires;
    credentialReference =
      cfg.systemd.services.pituitary.environment.PITUITARY_CREDENTIAL_PROFILES
      == "/etc/pituitary/credentials.json";
    limitsDeclared =
      cfg.services.pituitary.limits.maxTasks == 16 && cfg.services.pituitary.limits.reportBytes == 65536;
    unknownDelegation = lib.any (
      check: !check.assertion && lib.hasPrefix "services.pituitary.agents.builder" check.message
    ) invalid.assertions;
  };
  failed = lib.attrNames (lib.filterAttrs (_: passed: !passed) checks);
in
assert lib.assertMsg (
  failed == [ ]
) "Pituitary catalog evaluation failed: ${lib.concatStringsSep ", " failed}";
pkgs.runCommand "pituitary-catalog-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
  catalog=${cfg.services.pituitary.catalogFile}
  jq -e '.schemaVersion == 1 and .baySocket == "/run/bay/bay.sock"
    and .agents.builder.name == "builder" and .agents.builder.program == "pituitary-builder"
    and .agents.builder.delegatesTo == ["reviewer"] and .agents.builder.credentials == ["primary"]
    and .agents.builder.limits == {maxChildren: 2, maxDepth: 1} and .agents.reviewer.tools == ["read", "grep"]
    and .agents.builder.verification == {agent: "reviewer", checks: {unit: {command: ["true"], timeoutMs: 300000}}}' \
    "$catalog" >/dev/null
  jq -e --slurpfile catalog "$catalog" '. as $server | $catalog[0].agents.builder.machine as $machine
    | $server.programs["pituitary-builder"].machine == $machine
    and $server.machines[$machine].revision == $catalog[0].agents.builder.machineRevision
    and ($server.machines[$machine].base | startswith("bay-base-"))
    and $server.machines[$machine].resources == {cpus: 1, memory: 1, disk: 6}
    and $server.maxMemory == 2' ${serverConfig} >/dev/null
  test "$(${client}/bin/pituitary)" = /etc/pituitary/agents.json
  cp ${pkgs.writeText "pituitary-catalog-checks.json" (builtins.toJSON checks)} "$out"
''
