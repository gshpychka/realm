{
  pkgs,
  ...
}:
let
  bay = pkgs.callPackage ./bay { };
in
{
  vimPlugins = pkgs.vimPlugins // {
    ts-error-translator-nvim = pkgs.callPackage ./ts-error-translator-nvim.nix { };
  };
  piPackages = pkgs.callPackage ./pi-packages { };
  voice-broker = pkgs.callPackage ./voice-broker { };
  datameter = pkgs.callPackage ./datameter.nix { };
  pituitary = pkgs.callPackage ./pituitary { };
}
// pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  inherit bay;
  inherit (bay) flare;
}
