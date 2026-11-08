# Check backend independence and policy across composed host configurations.
# These are module/configuration checks: no daemon, secrets or model calls.
{ pkgs, host }:
let
  inherit (pkgs) lib;
  original = host.config;
  variant = settings: (host.extendModules { modules = [ settings ]; }).config;
  hermes = variant {
    my.voice-broker.backend = lib.mkForce "hermes";
    my.openclaw.enable = lib.mkForce false;
    my.openclaw.responsesEndpoint.enable = lib.mkForce false;
    # Hoard's separately enabled OpenClaw controller explicitly requires that
    # gateway; disable it too rather than attributing its assertion to the broker.
    my.openclaw.nixosControl.enable = lib.mkForce false;
  };
  overflow = variant {
    my.voice-broker.backend = lib.mkForce "hermes";
    my.voice-broker.overflow.enable = lib.mkForce true;
  };
  parallel = variant {
    my.voice-broker.backend = lib.mkForce "hermes";
    my.voice-broker.mode = lib.mkForce "parallel";
  };
  failure = needle: cfg: lib.any (a: !a.assertion && lib.hasInfix needle a.message) cfg.assertions;
  checks = {
    hermesWithoutOpenClaw = lib.all (a: a.assertion) hermes.assertions;
    noOpenClawCredential = !(hermes.sops.secrets ? "voice-broker/openclaw-secret");
    rejectsHermesOverflow = failure "overflow is OpenClaw-specific" overflow;
    rejectsParallel = failure "mode parallel" parallel;
    preservesVoiceAndRouting =
      original.my.voice-broker.settings.live.instructions
      == hermes.my.voice-broker.settings.live.instructions
      && original.my.voice-broker.settings.routing == hermes.my.voice-broker.settings.routing;
  };
  failed = lib.attrNames (lib.filterAttrs (_: passed: !passed) checks);
in
assert lib.assertMsg (
  failed == [ ]
) "Voice broker module checks failed: ${lib.concatStringsSep ", " failed}";
pkgs.writeText "voice-broker-module-checks.json" (builtins.toJSON checks)
