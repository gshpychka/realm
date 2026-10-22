{ pkgs, bun2nix }:
pkgs.stdenvNoCC.mkDerivation {
  name = "check-probabench";
  src = ./.;
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
    overrides = bun2nix.patchedDependenciesToOverrides {
      patchedDependencies = pkgs.lib.mapAttrs (
        _: patch: ./. + "/${patch}"
      ) (pkgs.lib.importJSON ./package.json).patchedDependencies;
    };
  };
  nativeBuildInputs = [
    bun2nix.hook
    pkgs.nodejs
  ];
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    bun run check
    runHook postBuild
  '';
  installPhase = "touch $out";
}
