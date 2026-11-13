{
  # Match the build group used by this machine's Nix installation.
  ids.gids.nixbld = 30000;

  nix = {
    settings = {
      # originally motivated by https://github.com/NixOS/nixpkgs/pull/369588?new_mergebox=true#issuecomment-2566272567
      sandbox = "relaxed";
      # https://github.com/NixOS/nix/issues/7273
      auto-optimise-store = false;
      accept-flake-config = true;
      http-connections = 0;
      # https://github.com/NixOS/nix/issues/11728#issuecomment-2725297584
      # 2000MB
      download-buffer-size = 2097152000;
    };
    gc = {
      automatic = true;
      interval = {
        Hour = 12;
      };
      options = "--delete-old";
    };
  };
}
