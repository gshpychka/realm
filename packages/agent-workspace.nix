# Pituitary and Dura share their source workspace and installed dependencies.
{
  lib,
  stdenvNoCC,
  bun,
}:
let
  production =
    path:
    lib.fileset.fileFilter (
      file:
      !(lib.any (suffix: lib.hasSuffix suffix file.name) [
        ".test.ts"
        ".test.tsx"
        ".fixture.ts"
        ".fixture.tsx"
      ])
    ) path;
  source = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../bun.lock
      ../tsconfig.base.json
      ./pituitary/package.json
      ./pituitary/tsconfig.json
      ./pituitary/patches
      (production ./pituitary/packages)
      ./dura/package.json
      ./dura/tsconfig.json
      (production ./dura/src)
    ];
  };
  dependencies = stdenvNoCC.mkDerivation {
    pname = "realm-agent-dependencies";
    version = "0.0.0";
    src = source;
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      runHook preBuild
      export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install --frozen-lockfile --production --ignore-scripts --no-progress --os='*' --cpu='*'
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      find . -type d -name node_modules -prune -exec cp --parents -R {} "$out/" \;
      runHook postInstall
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-iOs/cltwW0ny1An512PpCz9SUq4FUCcqmd7MOrw5u8w=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "realm-agent-workspace";
  version = "0.0.0";
  src = source;
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R . $out/
    chmod -R u+w $out
    cp -R ${dependencies}/. $out/
    runHook postInstall
  '';
}
