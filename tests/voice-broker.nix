# Evaluate both assistant selections, including Hermes with OpenClaw disabled.
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
    preservesOpenClaw = original.my.voice-broker.settings.agent.provider == "openclaw";
    openClawCredential = original.sops.secrets ? "voice-broker/openclaw-secret";
    openClawCallSkill = original.my.openclaw.skills ? voice-call;
    hermesWithoutOpenClaw = !hermes.my.openclaw.enable && lib.all (a: a.assertion) hermes.assertions;
    hermesProvider = hermes.my.voice-broker.settings.agent.provider == "hermes";
    hermesSocket =
      hermes.my.voice-broker.settings.agent.socket == "/run/voice-broker-hermes/agent.sock";
    noOpenClawCredential = !(hermes.sops.secrets ? "voice-broker/openclaw-secret");
    noOpenClawFields =
      !(hermes.my.voice-broker.settings.agent ? token_file)
      && !(hermes.my.voice-broker.settings.agent ? overflow)
      && !(hermes.my.voice-broker.settings.agent ? url);
    noOpenClawIdentity = hermes.my.voice-broker.identityFile == null;
    hermesCallSkill = hermes.my.hermes-agent.skills ? voice-call;
    hermesCallPermissions = builtins.elem "voice-broker" hermes.users.users.hermes.extraGroups;
    bridgeSameUser =
      hermes.systemd.services.voice-broker-hermes.serviceConfig.User == hermes.services.hermes-agent.user;
    bridgePrivateGroup =
      hermes.systemd.services.voice-broker-hermes.serviceConfig.Group == "voice-broker"
      && hermes.systemd.services.voice-broker-hermes.serviceConfig.RuntimeDirectoryMode == "0750";
    bridgeIsolatedInterpreter = lib.hasInfix " -I " hermes.systemd.services.voice-broker-hermes.serviceConfig.ExecStart;
    bridgeUsesPinnedSDK = lib.hasInfix (builtins.unsafeDiscardStringContext "${hermes.services.hermes-agent.package.hermesVenv}/bin/python") hermes.systemd.services.voice-broker-hermes.serviceConfig.ExecStart;
    ownerIdIsCredential =
      builtins.length hermes.systemd.services.voice-broker-hermes.serviceConfig.LoadCredential == 1
      && lib.hasInfix "--telegram-chat-id-file" hermes.systemd.services.voice-broker-hermes.serviceConfig.ExecStart;
    bridgeOrdered = builtins.elem "voice-broker-hermes.service" hermes.systemd.services.voice-broker.after;
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
