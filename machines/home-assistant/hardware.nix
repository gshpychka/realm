{ lib, ... }:
{
  # Samsung SSD 980 500GB is NVMe, not a USB/SATA boot drive. These labels
  # describe FUTURE media; they must never be applied to the running HAOS disk.
  fileSystems."/" = {
    device = "/dev/disk/by-label/HA_NIXOS";
    fsType = "ext4";
  };
  fileSystems."/boot/firmware" = {
    device = "/dev/disk/by-label/HA_FIRMWARE";
    fsType = "vfat";
    options = [ "umask=0077" ];
  };
  boot.loader.raspberry-pi = {
    bootloader = "kernel";
    firmwarePath = "/boot/firmware";
  };
  boot.initrd.availableKernelModules = [
    "nvme"
    "pcie_brcmstb"
    "xhci_pci"
  ];
  boot.kernelModules = [ "i2c-dev" ];
  hardware.raspberry-pi.config.all.base-dt-params.i2c_arm = {
    enable = true;
    value = "on";
  };
  # Explicit external PCIe enablement avoids depending on HAT+ detection for
  # the Argon NVMe board. Keep the default, supported PCIe generation.
  hardware.raspberry-pi.config.all.base-dt-params.pciex1 = {
    enable = true;
    value = "on";
  };
  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;
  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";
  # 4GB board: bound pressure without writing swap to a second unknown disk.
  zramSwap = {
    enable = true;
    memoryPercent = 25;
  };
  services.fstrim.enable = true;
}
