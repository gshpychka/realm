{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.neovim;
  cacheDir = "${config.xdg.cacheHome}/nvim";
  # vim.loader keys its bytecode cache on path, mtime and size; store files
  # all carry mtime 1, so a changed config or plugin set must drop the cache
  luacStamp = pkgs.writeText "nvim-luac-stamp" (
    lib.concatStringsSep "\n" (
      [ "${./config}" ] ++ map (p: "${p.plugin or p}") config.programs.neovim.plugins
    )
  );
in
{
  options.my.neovim = {
    enable = lib.mkEnableOption "Neovim text editor";
  };

  config = lib.mkIf cfg.enable {
    home.activation.clearNeovimLuaCache = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      if [ "$(readlink ${cacheDir}/luac.stamp)" != "${luacStamp}" ]; then
        run rm -rf ${cacheDir}/luac
        run mkdir -p ${cacheDir}
        run ln -sfn ${luacStamp} ${cacheDir}/luac.stamp
      fi
    '';

    programs.neovim = {
      enable = true;
      defaultEditor = true;
      vimAlias = true;
      plugins = with pkgs.vimPlugins; [
        # vim-sensible
        # vim-surround
        undotree
        gruvbox-nvim
        plenary-nvim

        # git-related plugins
        vim-fugitive
        gitsigns-nvim
        diffview-nvim
        gitlinker-nvim
        agitator-nvim

        # decorated scrollbar
        satellite-nvim
        hydra-nvim
        barbar-nvim
        lualine-nvim
        vim-tmux-navigator
        nvim-tree-lua
        nvim-web-devicons
        # noice requires nui-nvim and nvim-notify
        nui-nvim
        nvim-notify
        noice-nvim
        inc-rename-nvim
        text-case-nvim
        nvim-lspconfig
        nvim-lint
        flash-nvim
        # in-buffer markdown rendering, uses the markdown treesitter parsers
        render-markdown-nvim
        (nvim-treesitter.withPlugins (
          p: with p; [
            bash
            comment
            dockerfile
            hcl
            html
            javascript
            json
            json5
            lua
            nix
            python
            regex
            rust
            sql
            terraform
            toml
            typescript
            vim
            vimdoc
            yaml
            markdown
            markdown_inline
          ]
        ))
        claudecode-nvim
        neogen
        luasnip
        # nvim-lightbulb
        supermaven-nvim
        lspkind-nvim
        nvim-cmp
        cmp-nvim-lsp
        cmp-nvim-lua
        cmp-buffer
        telescope-nvim
        telescope-fzf-native-nvim
        telescope-ui-select-nvim
        tsc-nvim
        ts-error-translator-nvim
        snacks-nvim
      ];
      extraPackages = with pkgs; [
        # LSP servers
        typescript
        # extraPackages sit last on PATH, behind any project tsc; lspconfig's tsc server also accepts `tsgo`
        (writeShellScriptBin "tsgo" ''exec ${typescript}/bin/tsc "$@"'')
        pyright
        nixd
        lua-language-server
        zls
        bash-language-server
        yaml-language-server
        vscode-langservers-extracted # eslint, json
        dockerfile-language-server
        terraform-ls
        terraform # terraform-ls shells out to it for formatting
        biome # formatter/linter
        nixfmt
        statix
        deadnix

        ripgrep
      ];
    };
    xdg.configFile.nvim = {
      source = ./config;
      recursive = true;
    };
  };
}
