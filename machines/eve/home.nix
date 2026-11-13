{
  pkgs,
  config,
  ...
}:
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
          btop.enable = true;
          direnv.enable = true;
          finicky.enable = true;
          ghostty.enable = true;
          git.enable = true;
          gpg.enable = true;
          neovim.enable = true;
          nh.enable = true;
          npm.enable = true;
          pi = {
            enable = true;
            pituitary.enable = true;
          };
          sops = {
            enable = true;
            ageIdentity = "1password";
          };
          ssh.enable = true;
          tmux.enable = true;
          tools.enable = true;
          zsh.enable = true;
        };
        home = {
          file.".hushlogin".text = "";
          stateVersion = "26.11";
          packages = with pkgs; [
            yubikey-manager
          ];
        };
      };
  };
}
