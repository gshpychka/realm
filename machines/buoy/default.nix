# Bootstrap (from eve):
# cd infra && nix develop ..#infra   # provides tg/tf (terragrunt/terraform + sops-decrypted TF_VARs), gcloud, sops
# gcloud auth login && gcloud auth application-default login
# ./bootstrap/terraform-backend.sh   # new GCP project only: create tf state bucket
# nix build ..#packages.x86_64-linux.gce-image -o result   # bootstrap image .raw.tar.gz
# cd buoy && tg apply -var grant_vm_sops_age_key_access=true   # age key → Secret Manager, VM, data disk, static IP, DNS
#   rotating the age key: run it with -replace=age_secret_key.sops, then again with -replace=google_compute_instance.vm
#   (one apply creates the VM, the key and the grant in parallel)
# tg output -raw sops_age_public_key   # → buoy_host (new on first apply / lost tf state)
# ssh root@buoy cat /mnt/data/sops-age-key.txt | age-keygen -y   # prints buoy_host
#   otherwise (IAM grants take a minute or two): ssh root@buoy systemctl restart fetch-sops-age-key, and check again
# if buoy_host changed (repo root): set .sops.yaml buoy_host
#   nix shell nixpkgs#sops nixpkgs#gnupg -c find secrets -type f -exec sops updatekeys -y {} \;   # YubiKey plugged in
#   git commit -am rekey && git push
# nixos-rebuild switch --flake .#buoy --target-host root@buoy   # first deploy: bootstrap image authorizes root only
# in infra/buoy: tg apply   # revokes the VM's read access to the age key
# redeploy: nixos-rebuild switch --flake .#buoy --target-host buoy --sudo
{
  config,
  modulesPath,
  lib,
  ...
}:
{
  imports = [
    "${modulesPath}/virtualisation/google-compute-image.nix"
    ./filesystems.nix
    ./gatus.nix
    ./ntfy.nix
    ./cloudflare-tunnel.nix
    ./metadata-server.nix
  ];

  networking.hostName = "buoy";
  nixpkgs.hostPlatform = "x86_64-linux";
  system.stateVersion = "25.11";

  virtualisation.googleComputeImage.efi = true;

  programs.zsh = {
    enable = true;
    enableCompletion = false;
    enableGlobalCompInit = false;
    enableLsColors = false;
  };

  # age key from persistent storage, fetched and written by the bootstrap image.
  # The filename must match ageKeySecretName in infra/nixos/configuration.nix.
  sops.age.keyFile = "${config.fileSystems.data.mountPoint}/sops-age-key.txt";

  # handle auth in NixOS, not GCP
  security.googleOsLogin.enable = lib.mkForce false;

  users = {
    mutableUsers = false;
    users.${config.my.user} = {
      isNormalUser = true;
      extraGroups = [ "wheel" ];
      openssh.authorizedKeys.keys = [
        config.my.sshKeys.main
        config.my.sshKeys.openclaw
      ];
    };
  };

  services.openssh.enable = true;

  my.terminfo.enable = true;
}
