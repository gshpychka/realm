# Evaluate real guest machines without building or booting their images or calling a provider.
{ pkgs }:
let
  inherit (pkgs) lib;
  evaluate = import ../packages/pituitary/agent.nix;
  workerPackage = pkgs.writeShellScriptBin "pituitary-worker" "exit 0";
  common =
    { pkgs, ... }:
    {
      environment.systemPackages = [ pkgs.ripgrep ];
      environment.variables.PITUITARY_MACHINE_CHECK = "shared machine";
    };
  agent =
    name: role: extra:
    evaluate {
      inherit name pkgs workerPackage;
      modules = [
        {
          imports = [ common ];
          pituitary.agent = role;
        }
        extra
      ];
    };
  builder = agent "builder" {
    description = "Build one result.";
    instructions = "Implement and verify the requested change.";
    model = "anthropic/example-model";
    delegatesTo = [ "reviewer" ];
    credentials = [ "source-control" ];
  } { };
  reviewer = agent "reviewer" {
    description = "Review one result.";
    instructions = "Find defects in the submitted change.";
    model = "openai/example-model";
    tools = [
      "read"
      "grep"
    ];
  } { };
  changedMachine = agent "builder" { } { environment.systemPackages = [ pkgs.jq ]; };
  defaults = (agent "default" { } { }).manifest;
  rejects =
    role: !(builtins.tryEval (builtins.deepSeq (agent "invalid" role { }).manifest true)).success;
  expected = {
    schemaVersion = 1;
    name = "builder";
    description = "Build one result.";
    instructions = "Implement and verify the requested change.";
    model = "anthropic/example-model";
    tools = [
      "read"
      "bash"
      "edit"
      "write"
    ];
    delegatesTo = [ "reviewer" ];
    credentials = [ "source-control" ];
  };
  checks = {
    manifest = builder.manifest == expected;
    defaults = defaults.model == null && defaults.delegatesTo == [ ] && defaults.credentials == [ ];
    normalModules =
      builder.system.config.environment.variables.PITUITARY_MACHINE_CHECK == "shared machine";
    declaredPackages = lib.elem pkgs.ripgrep builder.system.config.environment.systemPackages;
    installedWorker = lib.elem workerPackage builder.system.config.environment.systemPackages;
    sharedSystem =
      builder.system.config.system.build.toplevel.drvPath
      == reviewer.system.config.system.build.toplevel.drvPath;
    sharedImage = builder.image == reviewer.image;
    distinctMachine = builder.image.disk != changedMachine.image.disk;
    distinctManifest = builder.manifestFile != reviewer.manifestFile;
    connection =
      builder.program.connect == [
        (lib.getExe workerPackage)
        "connect"
        "--socket"
        "/home/dev/.local/state/pituitary/worker.sock"
      ];
    resume = builder.program.command == builder.program.resume;
    history = builder.program.history == [ ".local/state/pituitary" ];
    unknownTool = rejects { tools = [ "arbitrary-host-tool" ]; };
    malformedModel = rejects { model = "missing-provider"; };
    credentialPath = rejects { credentials = [ "/run/secrets/token" ]; };
    duplicateDelegation = rejects {
      delegatesTo = [
        "reviewer"
        "reviewer"
      ];
    };
    malformedName = !(builtins.tryEval (agent "../escape" { } { }).manifest).success;
  };
  failed = lib.attrNames (lib.filterAttrs (_: passed: !passed) checks);
in
assert lib.assertMsg (
  failed == [ ]
) "Pituitary agent evaluation failed: ${lib.concatStringsSep ", " failed}";
pkgs.runCommand "pituitary-agents-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
  # Building the independent role manifest must not pull in a NixOS image closure.
  jq -e --argjson expected ${lib.escapeShellArg (builtins.toJSON expected)} '. == $expected' \
    ${builder.manifestFile} >/dev/null
  cp ${pkgs.writeText "pituitary-agent-checks.json" (builtins.toJSON checks)} "$out"
''
