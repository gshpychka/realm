# Build on hoard with: nix-build --option builders '' apps2samsung.nix
# result/bin/apps2samsung-cli install Vetro --tv TV_ADDRESS --allow-root --partner
# Signing certificates are created in the user's Apps2Samsung data directory.
# For a browser on eve while the CLI runs on hoard, forward the sign-in callback:
# ssh -N -L 127.0.0.1:4794:127.0.0.1:4794 hoard
# After installation, launch Vetro once, then set the TV's Developer Mode Host
# PC IP to 127.0.0.1 and restart. Its dashboard is http://TV_ADDRESS:8099/.
{
  pkgs ? import <nixpkgs> { },
}:
let
  raw = pkgs.stdenvNoCC.mkDerivation {
    pname = "apps2samsung-cli-unmodified";
    version = "3.3.0";
    src = pkgs.fetchurl {
      url = "https://github.com/Apps2Samsung/Apps2Samsung/releases/download/v3.3.0/Apps2Samsung.Cli-v3.3.0-linux-x64.tar.gz";
      sha256 = "a5ac49562c311cc5665f717480ef12952a0fa8eb87912ae430b83495499ed0b8";
    };
    sourceRoot = ".";
    dontConfigure = true;
    dontBuild = true;
    # The .NET single-file bundle uses byte offsets: patchelf/strip corrupt it.
    # Supply the Linux loader through the FHS environment instead.
    dontPatchELF = true;
    dontStrip = true;
    installPhase = ''
      mkdir -p "$out/bin"
      install -m755 apps2samsung-cli "$out/bin/apps2samsung-cli"
    '';
  };
in
pkgs.buildFHSEnv {
  name = "apps2samsung-cli";
  targetPkgs =
    p: with p; [
      stdenv.cc.cc.lib
      openssl
      icu
      zlib
      krb5
    ];
  runScript = "${raw}/bin/apps2samsung-cli";
}
