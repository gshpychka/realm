{
  lib,
  runCommand,
  bun,
  makeWrapper,
  stdenv,
  git,
  callPackage,
}:
let
  workspace = callPackage ../agent-workspace.nix { };
  pituitary = callPackage ../pituitary { };
in
runCommand "dura"
  {
    nativeBuildInputs = [ makeWrapper ];
    meta = {
      description = "Durable agent orchestration with declarative Bay machines";
      mainProgram = "dura";
    };
  }
  ''
    mkdir -p $out/bin
    makeWrapper ${bun}/bin/bun $out/bin/dura \
      --add-flags ${workspace}/packages/dura/src/main.ts \
      --prefix PATH : ${lib.makeBinPath [ git ]} \
      --suffix PATH : ${lib.makeBinPath [ pituitary ]} \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} \
      --set-default DURA_GIT ${git}/bin/git
  ''
