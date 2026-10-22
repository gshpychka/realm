{ pkgs }:
pkgs.mkShell {
  name = "pituitary";

  packages = with pkgs; [
    bun
    nodejs_22
    just
    typescript
    biome
    resvg
    jetbrains-mono
    jq
    git
    util-linux
    tmux
    gh
  ];

  PITUITARY_NVIM = "${pkgs.neovim-unwrapped}/bin/nvim";
  PITUITARY_GH = "${pkgs.gh}/bin/gh";
  PITUITARY_FONT_DIR = "${pkgs.jetbrains-mono}/share/fonts/truetype";
  PITUITARY_FALLBACK_FONT_DIR = "${pkgs.dejavu_fonts}/share/fonts/truetype";
  PITUITARY_SYMBOL_FONT_DIR = "${pkgs.nerd-fonts.symbols-only}/share/fonts/truetype/NerdFonts/Symbols";

  FONTCONFIG_FILE = pkgs.makeFontsConf {
    fontDirectories = [
      pkgs.jetbrains-mono
      pkgs.dejavu_fonts
    ];
  };
  TUI_TEST_RECORDING_FONT_FAMILIES = "JetBrains Mono,DejaVu Sans Mono";

  LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux (
    pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]
  );

  shellHook = ''
    realm_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    pituitary_root="$realm_root/packages/pituitary"

    export PI_SKIP_VERSION_CHECK=1
    export PI_OFFLINE=1
    echo "pituitary dev shell · bun $(bun --version) · node $(node --version)"
    if [ -f "$pituitary_root/packages/tui/src/main.tsx" ]; then
      # Keep development state within the checkout. Entering this shell from an
      # unrelated directory must not create a spurious packages/pituitary tree.
      export BUN_INSTALL_CACHE_DIR="$pituitary_root/.cache/bun"
      export npm_config_cache="$pituitary_root/.cache/npm"
      export PI_CODING_AGENT_SESSION_DIR="$pituitary_root/.pi/sessions"
      export PITUITARY_STATE_DIR="$pituitary_root/.pi/runs"
      export PATH="$pituitary_root/node_modules/.bin:$PATH"
      mkdir -p "$BUN_INSTALL_CACHE_DIR" "$npm_config_cache" "$PI_CODING_AGENT_SESSION_DIR"
      echo "cd $pituitary_root && just"
    else
      echo "Enter the dev shell from a Realm checkout to isolate caches and pi sessions."
    fi
  '';
}
