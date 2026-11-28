# Public immutable archives. Kept independent of the generated project cache.
{ pkgs }:
let
  idfArchive = pkgs.fetchurl {
    url = "https://github.com/esphome-libs/esp-idf/releases/download/v5.5.6/esp-idf-v5.5.6.tar.xz";
    sha256 = "adda9dc08e53fcd22c0522d41b45aacc7bf78e8654f62c04466bc0a4b607c099";
  };
in
{
  toolchain = pkgs.fetchzip {
    url = "https://github.com/espressif/crosstool-NG/releases/download/esp-14.2.0_20260121/xtensa-esp-elf-14.2.0_20260121-x86_64-linux-gnu.tar.xz";
    hash = "sha256-1Eyo43+ueDtb/mSDPDP6RvSSH0Zk4SfnkxWPJ2aWDgw=";
    stripRoot = false;
  };
  rom = pkgs.fetchzip {
    url = "https://github.com/espressif/esp-rom-elfs/releases/download/20241011/esp-rom-elfs-20241011.tar.gz";
    hash = "sha256-OCbYkTblDpKgpFCxOlYxWuc0qonI9dSn/t5SWZ7KYHI=";
    stripRoot = false;
  };
  idf =
    pkgs.runCommand "voice-pe-idf-5.5.6"
      {
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.xz
        ];
        requiredSystemFeatures = [ "big-parallel" ];
      }
      ''
        mkdir -p $out
        tar -xf ${idfArchive} --strip-components=1 -C $out
      '';
}
