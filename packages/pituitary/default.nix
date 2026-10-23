{
  lib,
  runCommand,
  bun,
  nodejs,
  makeWrapper,
  stdenv,
  neovim-unwrapped,
  gh,
  git,
  callPackage,
}:
let
  workspace = callPackage ../agent-workspace.nix { };
in
runCommand "pituitary"
  {
    nativeBuildInputs = [ makeWrapper ];
    meta = {
      description = "The terminal frontend for Pi and Dura";
      mainProgram = "pituitary";
    };
  }
  ''
    mkdir -p $out/bin $out/libexec/pituitary
    makeWrapper ${nodejs}/bin/node $out/libexec/pituitary/pi \
        --add-flags ${workspace}/packages/dura/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
      makeWrapper ${bun}/bin/bun $out/bin/pituitary \
        --add-flags ${workspace}/packages/pituitary/packages/tui/src/main.tsx \
        --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} \
      --suffix PATH : $out/libexec/pituitary \
        --set-default PITUITARY_NVIM ${neovim-unwrapped}/bin/nvim \
        --set-default PITUITARY_GIT ${git}/bin/git \
        --set-default PITUITARY_GH ${gh}/bin/gh
  ''
