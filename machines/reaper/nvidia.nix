{
  config,
  ...
}:
{
  # Community CUDA cache: https://wiki.nixos.org/wiki/CUDA
  nix.settings = {
    extra-substituters = [ "https://cache.nixos-cuda.org" ];
    extra-trusted-public-keys = [
      "cache.nixos-cuda.org:74DUi4Ye579gUqzH4ziL9IyiJBlDpMRn9MBN8oNan9M="
    ];
  };
  nixpkgs = {
    config = {
      # Do not enable cudaSupport globally: it changes package hashes and can
      # trigger expensive builds when the CUDA variants aren't cached.
      nvidia.acceptLicense = true;
    };
  };
  hardware = {
    nvidia = {
      # ensure GPU is awake while headless
      nvidiaPersistenced = true;
      powerManagement.enable = true;
      open = true;

      # GUI settings
      nvidiaSettings = true;
      package = config.boot.kernelPackages.nvidiaPackages.beta;
    };
    nvidia-container-toolkit.enable = true;
  };
  services.xserver = {
    videoDrivers = [ "nvidia" ];
  };
}
