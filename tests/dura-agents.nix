# Evaluate real guest machines without building or booting their images or calling a provider.
{ pkgs }:
let
  inherit (pkgs) lib;
  evaluate = import ../packages/dura/agent.nix;
  agent =
    name: role: extra:
    evaluate {
      inherit name pkgs;
      modules = [
        { dura.agent = role; }
        extra
      ];
    };
  builder = agent "builder" {
    description = "Build one result.";
    instructions = "Implement and verify the requested change.";
    model = "anthropic/example-model";
    delegatesTo = [ "reviewer" ];
    credentials = [ "source-control" ];
    limits = {
      maxChildren = 1;
      maxDepth = 1;
    };
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
  checks = {
    sharedSystem =
      builder.system.config.system.build.toplevel.drvPath
      == reviewer.system.config.system.build.toplevel.drvPath;
    sharedImage = builder.image == reviewer.image;
    distinctMachine = builder.image.disk != changedMachine.image.disk;
    distinctManifest = builder.manifestFile != reviewer.manifestFile;
  };
  failed = lib.attrNames (lib.filterAttrs (_: passed: !passed) checks);
in
assert lib.assertMsg (
  failed == [ ]
) "Dura agent evaluation failed: ${lib.concatStringsSep ", " failed}";
pkgs.runCommand "dura-agents-check" { } ''
  # Building the independent role manifest must not pull in a NixOS image closure.
  cp ${builder.manifestFile} "$out"
''
