{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.nh;
in
{
  options.my.nh = {
    enable = lib.mkEnableOption "nh - nix helper";
    enableZshIntegration = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable zsh integration with 'ns' alias";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.nh = {
      enable = true;
      flake = "${config.home.homeDirectory}/realm";
      clean = {
        enable = true;
        extraArgs = "--keep 5 --keep-since 5d --no-direnv";
      };
    };

    home.sessionVariables = {
      # use `sudo --non-interactive`
      NH_ELEVATION_STRATEGY = "passwordless";
    };

    programs.zsh.initContent = lib.mkIf cfg.enableZshIntegration ''
      # bare: switch this machine. with an arg: deploy to that host over ssh
      ns() {
        if (( $# == 0 )); then
          ${lib.getExe pkgs.nh} ${if pkgs.stdenv.hostPlatform.isDarwin then "darwin" else "os"} switch
        else
          local host="$1"
          shift
          ${lib.getExe pkgs.nh} os switch --target-host "$host" . "$@"
        fi
      }
    '';
  };
}
