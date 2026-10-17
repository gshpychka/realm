{ pkgs, source }:
pkgs.runCommand "voice-pe-unit-tests"
  {
    nativeBuildInputs = [
      pkgs.python3
      pkgs.gcc
    ];
    requiredSystemFeatures = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ "big-parallel" ];
  }
  ''
    mkdir -p source/scripts/voice-pe/components source/scripts/voice-pe/tests source/packages/voice-broker/src/voice_broker
    cp -r --no-preserve=mode,ownership ${source}/scripts/voice-pe/components/voice_broker source/scripts/voice-pe/components/
    cp ${source}/scripts/voice-pe/voice-pe.yaml source/scripts/voice-pe/
    cp ${source}/scripts/voice-pe/tests/test_startup.py ${source}/scripts/voice-pe/tests/test_provision.py source/scripts/voice-pe/tests/
    cp ${source}/packages/voice-broker/src/voice_broker/conversation.py source/packages/voice-broker/src/voice_broker/
    cd source
    python3 scripts/voice-pe/tests/test_startup.py
    python3 scripts/voice-pe/tests/test_provision.py
    touch $out
  ''
