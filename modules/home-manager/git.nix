{
  config,
  lib,
  osConfig,
  pkgs,
  ...
}:
let
  cfg = config.my.git;
in
{
  options.my.git = {
    enable = lib.mkEnableOption "Git version control";
    signing = {
      # Run once:
      #   nix run nixpkgs#gh -- auth refresh -s write:ssh_signing_key
      #   nix eval --raw .#nixosConfigurations.<host>.config.home-manager.users.<user>.my.git.signing.key | nix run nixpkgs#gh -- ssh-key add --type signing --title <host>
      key = lib.mkOption {
        type = lib.types.str;
        default = osConfig.my.sshKeys.main;
        description = "SSH public key commits are signed with";
      };
      agent = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Socket of the SSH agent holding the signing key, or null for the default signer";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    programs = {
      lazygit = {
        enable = true;
      };
      delta = {
        enable = true;
        enableGitIntegration = true;
      };
      git = {
        enable = true;
        signing = {
          format = "ssh";
          # git reads a literal key only after a `ssh-` or `key::` prefix
          key = "key::${cfg.signing.key}";
          signByDefault = true;
          signer =
            lib.mkIf (cfg.signing.agent != null)
              "${pkgs.writeShellScript "agent-ssh-sign" ''
                # ssh-keygen with the arguments git passes, signing through the configured agent
                SSH_AUTH_SOCK=${cfg.signing.agent} exec ${lib.getExe' pkgs.openssh "ssh-keygen"} "$@"
              ''}";
        };

        settings = {
          user = {
            email = "23005347+gshpychka@users.noreply.github.com";
            name = "Glib Shpychka";
          };
          alias = {
            cm = "commit";
            ca = "commit --amend --no-edit";
            di = "diff";
            dh = "diff HEAD";
            pu = "pull";
            ps = "push";
            pf = "push -f";
            st = "status -sb";
            co = "checkout";
            fe = "fetch";
            gr = "grep -in";
            re = "rebase -i";
          };
          init.defaultBranch = "main";
          pull = {
            ff = false;
            commit = false;
            rebase = true;
          };
          push.autoSetupRemote = true;
          delta.line-numbers = true;
          rerere.enabled = true;
        };
        includes = [
          {
            condition = "hasconfig:remote.*.url:git@gitlab.com:*/**";
            contents = {
              user.signingkey = osConfig.my.sshKeys.gitlab;
              user.email = "20539359-gshpychka@users.noreply.gitlab.com";
            };
          }
        ];
      };
    };
  };
}
