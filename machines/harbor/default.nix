# Bootstrap:
# nix build .#harbor-sd-image
# flash result/sd-image/*.img.zst to SD, boot harbor
# ssh -A pi@192.168.1.2
# nix-shell -p ssh-to-age --run 'ssh-to-age -i /etc/ssh/ssh_host_ed25519_key.pub'   # → harbor_host
# on eve: set .sops.yaml harbor_host
#         nix shell nixpkgs#sops nixpkgs#gnupg -c find secrets -type f -exec sops updatekeys -y {} \;   # YubiKey plugged in
#         git commit -am rekey && git push
# sudo nixos-rebuild switch --flake github:gshpychka/realm#harbor
{
  config,
  ...
}:
{
  imports = [
    ./hardware.nix
    ./boot.nix
    ./nix.nix
    ./filesystems.nix
    ./networking.nix
    ./time.nix
    ./users.nix
    ./nginx.nix
    ./rustdesk.nix
    ./syslog-receiver.nix
    ./home.nix
  ];

  networking.hostName = "harbor";
  nixpkgs.hostPlatform = "aarch64-linux";
  system.stateVersion = "22.11";

  my.user = "pi";

  nixpkgs.config.permittedInsecurePackages = [ "openssl-1.1.1w" ];

  programs.zsh = {
    enable = true;
    enableCompletion = false;
    enableGlobalCompInit = false;
    enableLsColors = false;
  };

  sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

  my.acme.enable = true;

  my.tailscale = {
    enable = true;
    magicDns = false;
    exitNode = true;
    advertiseRoutes = [ config.my.lan.cidr ];
  };

  my.cloudflare-ddns.enable = true;

  my.terminfo.enable = true;

  services.openssh.enable = true;
}
