# Bootstrap:
# 1. Create user account
# 2. Sign into the App Store.
# 3. xcode-select --install
# 4. sh <(curl -L https://nixos.org/nix/install)
# 5. git clone https://github.com/gshpychka/realm.git ~/realm && cd ~/realm
# 6. sudo ssh-keygen -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key
# 7. set .sops.yaml eve_host: nix-shell -p ssh-to-age --run 'ssh-to-age -i /etc/ssh/ssh_host_ed25519_key.pub'
# 8. nix shell nixpkgs#sops nixpkgs#gnupg -c find secrets -type f -exec sops updatekeys -y {} \;
# 9. nix --experimental-features "nix-command flakes" build .#darwinConfigurations.eve.system
#    ./result/sw/bin/darwin-rebuild switch --flake .#eve
# 10. 1Password > Developer: enable SSH agent + CLI

{
  config,
  pkgs,
  ...
}:
{
  imports = [
    ./system.nix
    ./window-management.nix
    ./homebrew.nix
    ./mas.nix
    ./xcode.nix
    ./nix.nix
    ./1password.nix
    ./menu-bar.nix
    ./home.nix
    ./secrets.nix
  ];

  networking = {
    hostName = "eve";
    computerName = "Eve";
  };

  nixpkgs.hostPlatform = "aarch64-darwin";

  # the prompt comes from the user's zsh config
  programs.zsh.promptInit = "";

  users.users.${config.my.user} = {
    home = "/Users/${config.my.user}";
    shell = pkgs.zsh;
  };

  programs.gnupg.agent = {
    # yubikey
    enable = true;
  };

  my.distributedBuilds = {
    enable = true;
    servers = [ "reaper" ];
    clientSpeedFactor = 50;
    sshKeyPath = config.sops.secrets.nixbuild-ssh-key.path;
  };

  my.terminfo.enable = true;
  system.stateVersion = 4;
}
