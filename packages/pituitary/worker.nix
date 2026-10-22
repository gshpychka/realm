{
  lib,
  stdenvNoCC,
  stdenv,
  bun,
  makeWrapper,
  bash,
  ripgrep,
  writeText,
}:
let
  # Keep one lockfile for the workspace. Only manifests are needed to resolve
  # the worker's dependencies; frontend source changes do not rebuild them.
  dependencySource = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./patches
      (lib.fileset.fileFilter (file: file.name == "package.json") ./packages)
    ];
  };
  runtimeFiles = lib.fileset.fileFilter (
    file:
    !(lib.any (suffix: lib.hasSuffix suffix file.name) [
      ".test.ts"
      ".test.tsx"
      ".fixture.ts"
      ".fixture.tsx"
    ])
  );
  source = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./packages/harness/src/worker.ts
      ./packages/harness/src/pi-engine.ts
      ./packages/harness/src/protocol.ts
      (runtimeFiles ./packages/rpc)
    ];
  };
  # Host CLI exports are not part of the worker. Keep dependency versions canonical
  # while avoiding an image rebuild when the host-only package surface changes.
  manifest = writeText "pituitary-worker-package.json" (
    builtins.toJSON (
      builtins.removeAttrs (lib.importJSON ./packages/harness/package.json) [
        "bin"
        "exports"
      ]
    )
  );
  dependencies = stdenvNoCC.mkDerivation {
    pname = "pituitary-worker-dependencies";
    version = "0.0.0";
    src = dependencySource;
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --filter @pituitary/harness --frozen-lockfile --production --ignore-scripts --no-progress --os='*' --cpu='*'
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R node_modules $out/
      for dir in packages/*/node_modules; do
        mkdir -p $out/$(dirname $dir)
        cp -R $dir $out/$dir
      done
      runHook postInstall
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-Ulv0vzzXNHVdE6HGwA9U3TgbYvHJQM7Ko2enB87oIog=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "pituitary-worker";
  version = "0.0.0";
  src = source;
  nativeBuildInputs = [ makeWrapper ];
  dontConfigure = true;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pituitary $out/bin
    cp -R . $out/share/pituitary
    chmod -R u+w $out/share/pituitary
    cp ${manifest} $out/share/pituitary/packages/harness/package.json
    cp -R ${dependencies}/. $out/share/pituitary/
    makeWrapper ${bun}/bin/bun $out/bin/pituitary-worker \
      --add-flags $out/share/pituitary/packages/harness/src/worker.ts \
      --prefix PATH : ${
        lib.makeBinPath [
          bash
          ripgrep
        ]
      } \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]}
    runHook postInstall
  '';
  meta = {
    description = "Persistent native Pi worker for Pituitary, without the terminal frontend";
    mainProgram = "pituitary-worker";
  };
}
