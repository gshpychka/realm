{ pkgs }:
let
  inherit (pkgs) lib;
  lock = builtins.fromJSON (builtins.readFile ./public-inputs.lock.json);
  assets = builtins.fromJSON (builtins.readFile ./assets.lock.json);
  fetch = item: pkgs.fetchurl { inherit (item) url sha256; };
  esphome = import ./esphome.nix { inherit pkgs; };
  python = pkgs.python3.withPackages (_: esphome.propagatedBuildInputs);
  components = builtins.path {
    path = ./components;
    name = "voice-pe-local-components";
    filter =
      path: type:
      type == "directory"
      || lib.any (suffix: lib.hasSuffix suffix path) [
        ".py"
        ".cpp"
        ".h"
      ];
  };
  mapping = pkgs.writeText "voice-pe-codegen-inputs.json" (
    builtins.toJSON {
      upstream = lib.mapAttrs (_: fetch) lock.upstream;
      components = lib.mapAttrs (_: fetch) lock.components;
      vendor = lib.mapAttrs (_: item: {
        archive = fetch item;
        inherit (item) url version;
      }) lock.vendor;
      models = lib.mapAttrs (_: model: {
        manifest = fetch model.manifest;
        model = fetch model.model;
      }) assets.models;
      xmos = fetch assets.xmos;
      xmosUrl = assets.xmos.url;
      localComponents = components;
      yaml = ./voice-pe.yaml;
      output = "output";
    }
  );
in
assert esphome.version == "2026.8.0";
assert pkgs.python3.pythonVersion == "3.14";
pkgs.runCommand "voice-pe-generated-project"
  {
    nativeBuildInputs = [ python ];
    requiredSystemFeatures = [ "big-parallel" ];
  }
  ''
    export HOME=$TMPDIR/home
    mkdir -p "$HOME"
    export PYTHONPATH=${esphome}/${pkgs.python3.sitePackages}
    export PYTHONDONTWRITEBYTECODE=1
    export PYTHONHASHSEED=0
    export SOURCE_DATE_EPOCH=1791763200
    export TZ=UTC
    python3 -c 'from pathlib import Path; assert len(Path("/proc/net/route").read_text().splitlines()) == 1'
    python3 ${./reconstruct.py} ${mapping}
    mv output $out
    cp ${./public-inputs.lock.json} $out/public-inputs.lock.json
    cp ${./assets.lock.json} $out/assets.lock.json
    printf "Offline code generation; declared public fetch inputs; no inherited caches\n" > $out/codegen-evidence.txt
  ''
