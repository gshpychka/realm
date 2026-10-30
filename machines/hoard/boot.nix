{ pkgs, ... }:
{

  boot = {
    loader = {
      grub.enable = false;
      systemd-boot = {
        enable = true;
        configurationLimit = 10;
        bootCounting.enable = true;
        # block kernel cmdline tampering from the boot menu
        editor = false;
      };
      efi.canTouchEfiVariables = true;
    };
    initrd = {
      availableKernelModules = [
        "xhci_pci"
        "ahci"
        "nvme"
        "usbhid"
        "usb_storage"
        "uas"
        "sd_mod"
      ];
    };
    kernelModules = [
      "kvm-intel"
    ];
    extraModulePackages = [ ];

    kernelPackages = pkgs.linuxPackages;
  };
}
