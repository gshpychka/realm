{
  config,
  lib,
  pkgs,
  osConfig,
  ...
}:
let
  cfg = config.my.btop;
  themeName = "gruvbox_dark_v2";
in
{
  options.my.btop = {
    enable = lib.mkEnableOption "btop system monitor";
  };

  config = lib.mkIf cfg.enable {
    # btop resolves color_theme names against this directory.
    xdg.configFile."btop/themes/${themeName}.theme".source =
      "${config.programs.btop.package}/share/btop/themes/${themeName}.theme";

    programs.btop = {
      enable = true;
      package = if osConfig.hardware.nvidia.enabled or false then pkgs.stableCudaPkgs.btop else pkgs.btop;
      settings = {
        color_theme = themeName;
        vim_keys = true;
        update_ms = 100;
        proc_tree = true;
        proc_aggregate = true;
        proc_filter_kernel = true;
        disks_filter = "exclude=/boot";
        io_mode = true;
        net_download = 1000;
        net_upload = 1000;
        net_auto = false;
      };
    };
  };
}
