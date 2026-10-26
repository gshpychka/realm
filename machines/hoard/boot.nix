{
  pkgs,
  config,
  ...
}:
{

  boot = {
    loader = {
      grub.enable = false;
      systemd-boot = {
        enable = true;
        configurationLimit = 10;
        # block kernel cmdline tampering from the boot menu
        editor = false;
      };
      efi.canTouchEfiVariables = true;
    };
    initrd = {
      # SSH in initrd for LUKS unlocking
      network = {
        enable = true;
        ssh = {
          enable = true;
          hostKeys = [
            # These keys were generated imperatively, they are not the regular host keys.
            # Justification from the docs:

            # Unless your bootloader supports initrd secrets,
            # these keys are stored insecurely in the global Nix store.
            # Do NOT use your regular SSH host private keys for this purpose or you'll expose them to regular users!

            # ssh-keygen -t ed25519 -N "" -f /etc/secrets/initrd/ssh_host_ed25519_key
            "/etc/secrets/initrd/ssh_host_ed25519_key"

            # ssh-keygen -t rsa -N "" -f /etc/secrets/initrd/ssh_host_rsa_key
            "/etc/secrets/initrd/ssh_host_rsa_key"
          ];
          port = 22;
          authorizedKeys = config.users.users.${config.my.user}.openssh.authorizedKeys.keys;
          authorizedKeyFiles = config.users.users.${config.my.user}.openssh.authorizedKeys.keyFiles;
        };
      };
      # automatically present LUKS password prompt on SSH connection
      # /bin/cryptsetup-askpass apparently only handles a single device at a time
      systemd.users.root.shell = "/bin/systemd-tty-ask-password-agent";
      availableKernelModules = [
        "xhci_pci"
        "ahci"
        "nvme"
        "usbhid"
        "usb_storage"
        "uas"
        "sd_mod"
      ];
      kernelModules = [
        "r8169" # ethernet driver
      ];
    };
    kernelModules = [
      "kvm-intel"
    ];
    extraModulePackages = [ ];

    kernelPackages = pkgs.linuxPackages;
  };
}
