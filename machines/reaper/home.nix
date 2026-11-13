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

        # reaper's TPM key logs in with no forwarded agent wherever a host authorizes it
        programs.ssh.settings = lib.mapAttrs' (
          name: _:
          lib.nameValuePair "${name}-tpm" (
            lib.hm.dag.entryBefore [ name ] {
              header = "Match final host ${name},${name}.${config.my.domain}";
              IdentityAgent = config.my.tpmSshKey.socket;
            }
          )
        ) (lib.filterAttrs (_: h: lib.elem config.my.sshKeys.reaper h.authorizedKeys) config.my.hosts);

        home.packages = with pkgs; [ ];

        home.stateVersion = "26.11";
      };
  };
}
