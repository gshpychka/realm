{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
{
  nix-homebrew = {
    enable = true;
    enableRosetta = false;
    user = config.system.primaryUser;
    taps = {
      "homebrew/homebrew-core" = inputs.homebrew-core;
      "homebrew/homebrew-cask" = inputs.homebrew-cask;
    };
    trust = {
      formulae = [
        # formulae go here
      ];
    };
    mutableTaps = false;
    extraEnv = {
      HOMEBREW_NO_ANALYTICS = "1";
    };
    # `brew shellenv` costs ~300ms per interactive zsh; systemPath below
    # carries its PATH entry
    enableZshIntegration = false;
  };
  environment.systemPath = [ "${config.homebrew.prefix}/bin" ];
  homebrew = {
    enable = true;
    taps = builtins.attrNames config.nix-homebrew.taps;
    global = {
      # nix-homebrew is handling homebrew updates
      autoUpdate = false;
    };
    onActivation = {
      # nix-homebrew is handling homebrew updates
      autoUpdate = false;
      upgrade = true;
      # --cleanup is deprecated
      cleanup = lib.mkForce "none";
    };
    caskArgs = {
      # no_quarantine is no longer a thing
      # no_quarantine = true;
    };
    casks = [
      # -- essentials --
      "google-chrome"
      "raycast"
      "ghostty"
      # -- utilities --
      "transmission"
      "commander-one"
      "forklift"
      "docker-desktop"
      {
        # choose browser on each link
        name = "finicky";
        greedy = true;
      }
      "betterdisplay"
      "insta360-link-controller"
      "dropbox"
      "google-drive"
      {
        name = "cyberduck";
        greedy = true;
      }
      {
        name = "teamviewer";
        greedy = true;
      }
      {
        name = "rustdesk";
        greedy = true;
      }
      "trezor-suite"
      {
        name = "gimp";
        greedy = true;
      }
      {
        name = "vlc";
        greedy = true;
      }
      {
        name = "balenaetcher";
        greedy = true;
      }
      "chatgpt"
      "codex-app"
      "claude"
      "caldigit-thunderbolt-charging"
      {
        name = "plexamp";
        greedy = true;
      }
      "coconutbattery"
      "losslesscut"
      "handbrake-app"
      # -- 3d printing
      {
        name = "bambu-studio";
        greedy = true;
      }
      # -- communication --
      "telegram"
      "signal"
      "discord"
      "element"

      # -- work --
      {
        name = "datagrip";
        greedy = false;
      }
      "firefox"
      "linear"
      "twingate"
      {
        name = "zoom";
        greedy = true;
      }
    ];
    brews = [
      "dagger"
    ];
  };
  # https://github.com/zhaofengli/nix-homebrew/issues/3#issuecomment-1622240992
  system.activationScripts.fixHomebrewPermissions.text = lib.mkOrder 1501 (
    lib.concatStringsSep "\n" (
      lib.mapAttrsToList (
        prefix: d:
        if d.enable then
          ''
            chown -R ${config.nix-homebrew.user} ${prefix}/bin
            chgrp -R ${config.nix-homebrew.group} ${prefix}/bin
          ''
        else
          ""
      ) config.nix-homebrew.prefixes
    )
  );

  # nix-darwin's `brew bundle --cleanup` is deprecated in favor of `brew bundle cleanup`
  system.activationScripts.postActivation.text = ''
    if [ -f "${config.homebrew.prefix}/bin/brew" ]; then
      echo >&2 "Homebrew cleanup (zap)..."
      PATH="${config.homebrew.prefix}/bin:$PATH" \
      sudo --preserve-env=PATH --user=${lib.escapeShellArg config.homebrew.user} --set-home \
        brew bundle cleanup --zap --force --file=${pkgs.writeText "Brewfile" config.homebrew.brewfile}
    fi
  '';
}
