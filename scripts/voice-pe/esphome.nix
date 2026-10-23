# Firmware code generation is versioned with its SDK and public input locks,
# independently of the ESPHome CLI supplied by the fleet's rolling nixpkgs.
{ pkgs }:
pkgs.esphome.overrideAttrs (finalAttrs: {
  version = "2026.8.0";
  src = pkgs.fetchFromGitHub {
    owner = "esphome";
    repo = "esphome";
    tag = finalAttrs.version;
    # From nixpkgs fe13242281a67641c0102cdb1087f0ebe586c7df,
    # the package set used to validate this firmware's offline generator.
    hash = "sha256-IgNE3+qqptFYL3wuFZWgkoT8bpjMMmI56nQcSMl4i/o=";
  };
  # August's source has a different wheel constraint from September's CLI.
  postPatch = ''
    substituteInPlace pyproject.toml \
      --replace-fail "setuptools==84.0.0" "setuptools" \
      --replace-fail "wheel>=0.43,<0.48" "wheel"
  '';
})
