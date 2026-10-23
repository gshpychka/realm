{
  lib,
  stdenvNoCC,
  bun,
  makeWrapper,
  stdenv,
  neovim-unwrapped,
  gh,
}:
let
  # Bun runs the workspace from source. Keep tests, development tools, and the
  # rest of Realm outside the runtime closure and dependency hash.
  source = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./bun.lock
      ./tsconfig.json
      ./tsconfig.base.json
      ./patches
      (lib.fileset.fileFilter (
        file:
        !(lib.any (suffix: lib.hasSuffix suffix file.name) [
          ".test.ts"
          ".test.tsx"
          ".fixture.ts"
          ".fixture.tsx"
        ])
      ) ./packages)
    ];
  };

  # Include every platform's optional native packages, so one hash serves all systems.
  dependencies = stdenvNoCC.mkDerivation {
    pname = "pituitary-dependencies";
    version = "0.0.0";
    src = source;
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --production --ignore-scripts --no-progress --os='*' --cpu='*'
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
    outputHash = "sha256-9MbaDKZqtjfqZaD6FUs7wFXSg0yjIQjNNmlB6HZMDQw=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "pituitary";
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
    cp -R ${dependencies}/. $out/share/pituitary/
    # Use the operator's pi, settings, extensions, and sessions.
    makeWrapper ${bun}/bin/bun $out/bin/pituitary \
      --add-flags $out/share/pituitary/packages/tui/src/main.tsx \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} \
      --set-default PITUITARY_NVIM ${neovim-unwrapped}/bin/nvim \
      --set-default PITUITARY_GH ${gh}/bin/gh
    runHook postInstall
  '';
  meta = {
    description = "OpenTUI frontend for the pi coding agent";
    mainProgram = "pituitary";
  };
}
