{
  config,
  pkgs,
  ...
}:
{
  home-manager = {
    users.${config.my.user} =
      { lib, ... }:
      {
        imports = [
          ../../modules/home-manager
        ];

        my = {
          ai.enable = true;
          btop.enable = true;
          cachePrune.enable = true;
          direnv.enable = true;
          git.enable = true;
          gpg.enable = true;
          neovim.enable = true;
          nh.enable = true;
          pi = {
            enable = true;
            pituitary.enable = true;
          };
          sops = {
            enable = true;
            ageIdentity = "host-key";
          };
          ssh.enable = true;
          tmux.enable = true;
          tools.enable = true;
          zsh.enable = true;
        };

        # kodi authorizes reaper's TPM key, which logs in with no forwarded agent
        programs.ssh.settings.kodi-tpm = lib.hm.dag.entryBefore [ "kodi" ] {
          header = "Match final host kodi,kodi.${config.my.domain}";
          IdentityAgent = config.my.tpmSshKey.socket;
        };

        home.packages = with pkgs; [ ];

        home.stateVersion = "24.05";
      };
  };
}
