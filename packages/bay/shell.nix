{ pkgs }:
pkgs.mkShell {
  packages = with pkgs; [
    go
    gopls
    git
    nixd
    nixfmt
    statix
    deadnix
    shellcheck
    shfmt
  ];
}
