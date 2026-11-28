inputs: [
  (_final: prev: {
    # Prefer stable nixpkgs for CUDA binary cache reuse.
    stableCudaPkgs = import inputs.nixos-stable {
      inherit (prev.stdenv.hostPlatform) system;
      config = {
        allowUnfree = true;
        nvidia.acceptLicense = true;
        cudaSupport = true;
      };
    };
  })
  (import ./llm-agents.nix inputs)
  (_final: prev: import ../packages { pkgs = prev; })
  (import ./docker.nix)
  (import ./openclaw.nix inputs)
  (import ./tmux.nix)
  inputs.mcp-servers-nix.overlays.default
]
