{ config, pkgs, ... }:
{
  home-manager = {
    users.${config.my.user} =
      { ... }:
      {
        imports = [
          ../../modules/home-manager
        ];

        my = {
          ai.enable = true;
          tmux.enable = true;
          btop.enable = true;
          git.enable = true;
          neovim.enable = true;
          nh.enable = true;
          sops = {
            enable = true;
            ageIdentity = "host-key";
          };
          ssh.enable = true;
          tools.enable = true;
          zsh.enable = true;
          direnv.enable = true;
        };

        home.packages = with pkgs; [ ];

        home.stateVersion = "26.11";
      };
  };
}
