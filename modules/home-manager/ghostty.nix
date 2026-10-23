{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.ghostty;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
in
{
  options.my.ghostty = {
    enable = lib.mkEnableOption "Ghostty terminal emulator";
  };

  config = lib.mkIf cfg.enable {
    programs.ghostty = {
      enable = true;
      # on macOS, installed via homebrew
      package = lib.mkIf isDarwin null;
      clearDefaultKeybinds = false;
      enableZshIntegration = true;
      settings = {
        theme = "Gruvbox Dark";
        cursor-style = "block";
        window-padding-x = 5;
        window-padding-y = 5;
        window-padding-balance = true;
        quit-after-last-window-closed = true;
        auto-update = "off";
        copy-on-select = "clipboard";

        font-family = "JetBrainsMono Nerd Font";
        font-family-bold = "JetBrainsMono Nerd Font";
        font-family-italic = "JetBrainsMono Nerd Font";
        font-family-bold-italic = "JetBrainsMono Nerd Font";

        font-style = "Regular";
        font-style-bold = "Bold";
        font-style-italic = "Italic";
        font-thicken = true;
        font-size = 12;
      }
      // lib.optionalAttrs isDarwin {
        window-colorspace = "display-p3";
        macos-titlebar-style = "hidden";
        macos-option-as-alt = true;
      };
    };
  };
}
