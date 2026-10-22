{
  config,
  lib,
  pkgs,
  osConfig,
  ...
}:
let
  cfg = config.my.tmux;
  # stable symlink to the newest forwarded-agent socket, which sshd places at a random path per connection; tmux panes outlive their connection
  agentSock = "${config.home.homeDirectory}/.ssh/ssh_auth_sock";
  # == true also handles nix-darwin, where the option is null when unmanaged
  sshdHost = (osConfig.services.openssh.enable or false) == true;
in
{
  options.my.tmux = {
    enable = lib.mkEnableOption "Tmux terminal multiplexer";
  };

  config = lib.mkIf cfg.enable {
    programs.tmux = {
      enable = true;
      mouse = true;
      baseIndex = 1;
      escapeTime = 0;
      historyLimit = 1000000;
      keyMode = "vi";
      focusEvents = true;
      disableConfirmationPrompt = true;
      # would be cooler to use "tmux-direct" but zsh can't handle it
      # we still get 16M colors via config
      terminal = "tmux-256color";
      extraConfig = lib.concatStringsSep "\n" (
        map lib.fileContents [
          ./gruvbox-dark.conf
          ./status.conf
          ./tmux.conf
          ./vim-tmux-navigator.conf
        ]
      );
    };

    # sshd runs this at session setup (sshd(8): ~/.ssh/rc)
    home.file.".ssh/rc" = lib.mkIf sshdHost {
      text = ''
        if [ -S "''${SSH_AUTH_SOCK:-}" ]; then
          ${pkgs.coreutils}/bin/ln -sfn "$SSH_AUTH_SOCK" "${agentSock}"
        fi
      '';
    };

    # Scoped to SSH-originated shells (tmux propagates SSH_CONNECTION on
    # attach), which are the sessions a forwarded agent belongs to.
    programs.zsh.initContent = lib.mkIf sshdHost ''
      if [[ -n "''${SSH_CONNECTION-}" && -S "${agentSock}" ]]; then
        export SSH_AUTH_SOCK="${agentSock}"
      fi
    '';
  };
}
