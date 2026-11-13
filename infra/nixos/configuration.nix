{
  modulesPath,
  lib,
  pkgs,
  config,
  ...
}:
let
  values = import ../../modules/common/values.nix;
  # also the filename (plus .txt) the runtime config reads the key from -
  # see sops.age.keyFile in machines/buoy/default.nix
  ageKeySecretName = "sops-age-key";
  # bind-mounted as /var/lib by the runtime config (machines/buoy/filesystems.nix)
  dataDirectoriesToBootstrap = [ "${config.fileSystems.data.mountPoint}/var-lib" ];
  authorizedSshKey = values.sshKeys.main;
  inherit (values) gcpProjectId;
in
{
  imports = [
    "${modulesPath}/virtualisation/google-compute-image.nix"
    ../../machines/buoy/data-disk.nix
    # this image reads the age key with the VM's service-account token
    ../../machines/buoy/metadata-server.nix
  ];

  virtualisation.googleComputeImage.efi = true;

  system.stateVersion = "26.11";

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };
  # configure auth declaratively here instead of having GCP handle it
  security.googleOsLogin.enable = lib.mkForce false;

  users.users.root.openssh.authorizedKeys.keys = [
    authorizedSshKey
  ];

  # fetch the age key from Secret Manager and write to the persistent disk
  systemd.services.fetch-sops-age-key = {
    description = "Fetch SOPS age key from GCP Secret Manager";
    wantedBy = [ "multi-user.target" ];
    requires = [ "network-online.target" ];
    after = [ "network-online.target" ];

    unitConfig.RequiresMountsFor = config.fileSystems.data.mountPoint;

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };

    script = ''
      KEY_FILE="${config.fileSystems.data.mountPoint}/${ageKeySecretName}.txt"
      TMP_FILE="$KEY_FILE.tmp"
      # files are private from creation
      umask 077

      echo "Fetching SOPS age key '${ageKeySecretName}' from Secret Manager..."
      if ! ${pkgs.google-cloud-sdk}/bin/gcloud secrets versions access latest \
        --secret=${ageKeySecretName} \
        --project=${gcpProjectId} \
        --format='get(payload.data)' \
        --out-file="$TMP_FILE"; then
        rm -f "$TMP_FILE"
        # the secret is readable only while granted; the disk outlives the VM
        if [ -s "$KEY_FILE" ]; then
          echo "Could not fetch the SOPS age key; keeping the existing $KEY_FILE"
          exit 0
        fi
        echo "Could not fetch the SOPS age key and $KEY_FILE doesn't exist:" \
          "tg apply -var grant_vm_sops_age_key_access=true in infra/buoy," \
          "then systemctl restart fetch-sops-age-key" >&2
        exit 1
      fi

      mv "$TMP_FILE" "$KEY_FILE"
      echo "SOPS age key successfully written to $KEY_FILE"
    '';
  };

  # create directories on the persistent disk
  systemd.tmpfiles.rules = lib.forEach dataDirectoriesToBootstrap (dir: "d '${dir}' 0755 root root");
}
