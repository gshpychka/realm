# Offline ESP32-S3 firmware; compilation must run on reaper (--max-jobs 0).
{ pkgs }:
let
  inherit (pkgs) lib;
  project = import ./project.nix { inherit pkgs; };
  sdk = import ./sdk-inputs.nix { inherit pkgs; };
  inherit (sdk) idf rom;
  pythonModules = import ./python-inputs.nix { inherit pkgs; };
  toolchain = pkgs.stdenvNoCC.mkDerivation {
    pname = "voice-pe-xtensa-offline";
    version = "14.2.0-20260121";
    src = sdk.toolchain;
    dontUnpack = true;
    dontBuild = true;
    dontStrip = true;
    requiredSystemFeatures = [ "big-parallel" ];
    nativeBuildInputs = [
      pkgs.patchelf
      pkgs.file
    ];
    installPhase = ''
      mkdir -p $out
      cp -r $src/. $out/
      chmod -R u+w $out
      find $out -type f -print0 | while IFS= read -r -d "" f; do
        description=$(file -b "$f")
        case "$description" in
          *"ELF 64-bit"*"x86-64"*)
            [[ "$description" == *"shared object"* || "$description" == *"dynamically linked"* ]] || continue
            patchelf --print-rpath "$f" >/dev/null 2>&1 || continue
            if patchelf --print-interpreter "$f" >/dev/null 2>&1; then
              patchelf --set-interpreter '${pkgs.stdenv.cc.bintools.dynamicLinker}' "$f"
            fi
            patchelf --set-rpath '${
              lib.makeLibraryPath [
                pkgs.stdenv.cc.cc
                pkgs.glibc
                pkgs.zlib
                pkgs.gmp
                pkgs.mpfr
                pkgs.libmpc
              ]
            }' "$f"
            ;;
        esac
      done
    '';
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "voice-pe-firmware";
  version = "26.9.0-esphome-${pkgs.esphome.version}";
  src = project;
  requiredSystemFeatures = [ "big-parallel" ];
  nativeBuildInputs = [
    pkgs.cmake
    pkgs.ninja
    pkgs.python3
    pkgs.git
    pkgs.file
  ];
  dontUseCmakeConfigure = true;
  dontUseNinjaBuild = true;
  dontUseNinjaInstall = true;
  enableParallelBuilding = true;
  postPatch = ''
    # Match the registry-qualified names referenced by component manifests.
    mv vendor/Improv vendor/improv__Improv
    PYTHONPATH='${pythonModules}' python3 ${./offline-components.py}
    # Remove plaintext entirely: even connections opened before key provisioning
    # must never be allowed to invoke the credential service.
    sed -i '/^#define USE_API_PLAINTEXT$/d' src/esphome/core/defines.h
    grep -q '^#define USE_API_NOISE$' src/esphome/core/defines.h
    ! grep -q '^#define USE_API_PLAINTEXT$' src/esphome/core/defines.h
  '';
  # This is an ordinary derivation: sandbox blocks network, not a firmware FOD.
  configurePhase = ''
    runHook preConfigure
    export HOME=$TMPDIR/home
    mkdir -p "$HOME"
    # Fail rather than silently compiling outside a network-isolated sandbox.
    python3 -c 'from pathlib import Path; routes = Path("/proc/net/route").read_text().splitlines(); assert len(routes) == 1, "Network routes present: offline sandbox required"'
    printf 'Nix ordinary derivation; no network routes; IDF manager disabled\n' > offline-evidence.txt
    export IDF_PATH='${idf}'
    export IDF_COMPONENT_MANAGER=0
    export PYTHONPATH='${pythonModules}'
    export ESP_ROM_ELF_DIR='${rom}'
    export PATH='${toolchain}/xtensa-esp-elf/bin':$PATH
    test "$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')" = 3.14
    ! grep -F 'set_token(' src/main.cpp
    ! grep -E 'set_ssid\(|set_password\(|set_noise_psk\(' src/main.cpp
    # No temporary source machine absolute paths may be consumed.
    if grep -R -l '/tmp/voice-pe-validate' --include='CMakeLists.txt' --include='*.cmake' .; then
      echo "Non-relocatable source cache" >&2; exit 1
    fi
    cmake -S . -B build -G Ninja \
      -DPYTHON=$(command -v python3) -DPYTHON_DEPS_CHECKED=1 \
      -DIDF_TARGET=esp32s3 -DSDKCONFIG=$PWD/sdkconfig.home-assistant-voice \
      -DCMAKE_BUILD_TYPE=MinSizeRel
    python3 ${./discover-idf.py}
    cmake -S . -B build -G Ninja \
      -DPYTHON=$(command -v python3) -DPYTHON_DEPS_CHECKED=1 \
      -DIDF_TARGET=esp32s3 -DSDKCONFIG=$PWD/sdkconfig.home-assistant-voice \
      -DCMAKE_BUILD_TYPE=MinSizeRel
    runHook postConfigure
  '';
  buildPhase = ''
    runHook preBuild
    cmake --build build --parallel $NIX_BUILD_CORES
    runHook postBuild
  '';
  installPhase = ''
    mkdir -p $out
    cp build/home-assistant-voice.bin $out/firmware.bin
    cp build/bootloader/bootloader.bin $out/
    cp build/partition_table/partition-table.bin $out/
    cp build/home-assistant-voice.elf $out/
    cp build/esp_idf_size.json $out/
    cp ${./public-inputs.lock.json} $out/input-lock.json
    cp ${./assets.lock.json} $out/assets.lock.json
    cp ${./python-inputs.lock.json} $out/python-inputs.lock.json
    cp codegen-evidence.txt $out/
    cp ${./nix-inputs.provenance.json} $out/input-provenance.json
    cp offline-evidence.txt $out/
    printf '%s\n' '${project}' '${idf}' '${rom}' '${pythonModules}' '${toolchain}' > $out/pinned-input-paths
    cp build/flasher_args.json $out/
    printf '%s\n' 'Credential-free firmware. Provision broker token via authenticated Noise API after explicit flashing.' > $out/README
    (cd $out; sha256sum *.bin *.elf > SHA256SUMS)
  '';
  dontFixup = true;
  passthru = {
    credentialFree = true;
    inherit project pythonModules;
  };
  meta.description = "Offline Voice PE firmware with runtime credential provisioning";
  meta.platforms = [ "x86_64-linux" ];
}
