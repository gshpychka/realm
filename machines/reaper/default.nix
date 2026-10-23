# Bootstrap:
# TODO: rework for dual-boot — reaper shares this disk with Windows. As written
# this assumes an empty disk and is destructive: `sgdisk -Z` and the fixed two-
# partition layout wipe Windows. The real procedure must keep the Windows
# partitions, reuse the existing ESP, and carve only the ext4 root from free space.
# flash .#iso to USB, boot reaper
# ssh nixos@iso
# lsblk   # find <disk> (e.g. /dev/nvme0n1), partitions are <disk>p1 <disk>p2
# sgdisk -Z <disk> && sgdisk -n1:0:+1G -t1:EF00 -n2:0:0 <disk>
# mkfs.fat -F32 -i D6D6CDCD <disk>p1 && mkfs.ext4 -L nixos <disk>p2
# mount /dev/disk/by-label/nixos /mnt && mount -m /dev/disk/by-uuid/D6D6-CDCD /mnt/boot
# mkdir -p /mnt/etc/ssh && ssh-keygen -t ed25519 -N "" -f /mnt/etc/ssh/ssh_host_ed25519_key
# nix-shell -p ssh-to-age --run 'ssh-to-age -i /mnt/etc/ssh/ssh_host_ed25519_key.pub'   # → reaper_host
# on eve: set .sops.yaml reaper_host; rm secrets/reaper/users.yaml
#         nix-shell -p mkpasswd --run 'mkpasswd -m sha-512'
#         sops secrets/reaper/users.yaml: gshpychka-hashed-password, jovian-hashed-password
#         nix shell nixpkgs#sops nixpkgs#gnupg -c find secrets -type f -exec sops updatekeys -y {} \;
#         git commit -am rekey && git push
# sbctl create-keys && mkdir -p /mnt/var/lib && cp -a /var/lib/sbctl /mnt/var/lib/
# nixos-install --flake github:gshpychka/realm#reaper && reboot
# sbctl enroll-keys --microsoft --ignore-immutable   # BIOS in Setup Mode
{
  pkgs,
  config,
  ...
}:
{
  imports = [
    ./boot.nix
    ./nix.nix
    ./filesystems.nix
    ./hardware.nix
    ./users.nix
    ./jovian
    ./kokoro.nix
    ./whisper.nix
    ./monitoring.nix
    ./netconsole.nix
    ./home.nix
    ./openwebui.nix
    ./gpu-ai-slice.nix
    ./tty.nix
    ./bay.nix
    ./dura.nix
    ./twingate.nix
    # ./comfyui.nix
  ];
  networking.hostName = "reaper";
  nixpkgs.hostPlatform = "x86_64-linux";
  system.stateVersion = "24.05";

  networking = {
    usePredictableInterfaceNames = true;
    enableIPv6 = false;
    interfaces = {
      eno3 = {
        wakeOnLan.enable = true;
      };
    };
  };

  my.buildServer = {
    enable = true;
    systems = [
      # Support both native and ARM builds
      "x86_64-linux"
      "aarch64-linux"
    ];
    maxJobs = 16;
    speedFactor = 100;
    supportedFeatures = [
      "nixos-test"
      "benchmark"
      "big-parallel"
      "kvm"
    ];
    clientPublicKeys = [
      config.my.nixbuildKeys.eve
      config.my.nixbuildKeys.hoard
      config.my.nixbuildKeys.harbor
    ];
  };

  # Enable QEMU binfmt emulation for cross-compilation
  boot.binfmt.emulatedSystems = [ "aarch64-linux" ];

  security = {
    sudo = {
      extraRules = [
        {
          users = [ "hass" ];
          commands = [
            {
              command = "/run/current-system/sw/bin/bootctl";
              options = [ "NOPASSWD" ];
            }
            {
              command = "/run/current-system/sw/bin/reboot";
              options = [ "NOPASSWD" ];
            }
            {
              command = "/run/current-system/sw/bin/shutdown";
              options = [ "NOPASSWD" ];
            }
          ];
        }
      ];
    };
  };

  my.gaming.enable = false;
  my.open-webui.enable = false;
  my.bay.enable = false;

  sops = {
    age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    defaultSopsFile = ../../secrets/reaper/users.yaml;
    secrets.gshpychka-hashed-password.neededForUsers = true;
  };

  my.acme.enable = true;

  my.tailscale = {
    enable = true;
    magicDns = false;
    authKeySopsFile = ../../secrets/reaper/tailscale.yaml;
  };

  virtualisation = {
    docker = {
      enable = true;
      storageDriver = "overlay2";
      rootless = {
        enable = true;
        setSocketVariable = true;
        daemon.settings = {
          max-concurrent-downloads = 10;
          features.cdi = true;
        };
      };
      autoPrune = {
        enable = true;
        # also remove tagged images no container uses
        flags = [ "--all" ];
      };
    };
  };

  programs.zsh = {
    enable = true;
    enableCompletion = false;
    enableBashCompletion = false;
    enableLsColors = false;
  };

  my.ollama = {
    enable = true;
    loadModels = [
      {
        # home assistant
        name = "qwen3.5:9b-q8_0";
        loadIntoVram = true;
      }
      {
        name = "llama3.1:8b-instruct-fp16";
      }
    ];
  };

  my.terminfo.enable = true;

  # Start pcscd on boot instead of socket-activation (needed for GPG smartcard)
  systemd.services.pcscd.wantedBy = [ "multi-user.target" ];

  # Allow users in plugdev group to access PC/SC smartcards
  security.polkit.extraConfig = ''
    polkit.addRule(function(action, subject) {
      if ((action.id == "org.debian.pcsc-lite.access_pcsc" ||
           action.id == "org.debian.pcsc-lite.access_card") &&
          subject.isInGroup("plugdev")) {
        return polkit.Result.YES;
      }
    });
  '';

  services = {
    pcscd.enable = true;
    udev.packages = [ pkgs.yubikey-personalization ];
    openssh.enable = true;
    nginx = {
      enable = true;
      recommendedTlsSettings = true;
      virtualHosts = {
        "default" = {
          serverName = config.networking.fqdn;
          useACMEHost = config.networking.fqdn;
          onlySSL = true;
          default = true;
          locations = {
            "/" = {
              return = "404";
            };
          };
        };
      };
    };

  };

  programs = {
    gnupg.agent.enable = true;
    nix-ld.enable = true;
  };
  networking.firewall.allowedTCPPorts = [
    config.services.nginx.defaultSSLListenPort
  ];

}
