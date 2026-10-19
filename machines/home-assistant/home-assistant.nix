{
  inputs,
  lib,
  pkgs,
  ...
}:
let
  haPkgs = import inputs.nixpkgs { system = pkgs.stdenv.hostPlatform.system; };
  packages = import ../../packages/home-assistant { pkgs = haPkgs; };
  declarations = builtins.fromJSON (builtins.readFile ./configuration.json);
in
{
  assertions = [
    {
      assertion = lib.versionAtLeast packages.core.version "2026.10.2";
      message = "Never start an older HA Core against the migrated 2026.10.2 state.";
    }
  ];
  services.home-assistant = {
    enable = true;
    package = packages.core;
    configDir = "/var/lib/hass";
    config = declarations;
    extraComponents = packages.coreComponents;
    inherit (packages) customComponents;
    openFirewallForComponents = true;
  };
  systemd.services.home-assistant = {
    wants = [
      "mosquitto.service"
      "matter-server.service"
    ];
    after = [
      "mosquitto.service"
      "matter-server.service"
    ];
    # Fail closed on a future empty installation. The marker may only be made
    # after an operator has reviewed the offline consistency/readiness report.
    unitConfig.ConditionPathExists = "/var/lib/hass/.migration-ready";
    serviceConfig = {
      LoadCredential = [ "secrets.yaml:/var/lib/private/home-assistant/secrets.yaml" ];
      MemoryHigh = "2500M";
      MemoryMax = "3G";
    };
    path = [ pkgs.openssh ];
    preStart = lib.mkAfter ''
      ln -sfn "$CREDENTIALS_DIRECTORY/secrets.yaml" /var/lib/hass/secrets.yaml
      mkdir -p /var/lib/hass/pyscript/apps /var/lib/hass/yasno-address-guard
      # The app source is immutable; its transaction/recovery journal is state.
      if test -e /var/lib/hass/pyscript/apps/yasno_address_guard && ! test -L /var/lib/hass/pyscript/apps/yasno_address_guard; then
        echo 'Review the existing guard source directory before enabling declarative ownership.' >&2
        exit 1
      fi
      ln -sfn ${./yasno-address-guard} /var/lib/hass/pyscript/apps/yasno_address_guard
      test -r /var/lib/hass/.storage/core.config_entries
      test -r /var/lib/hass/.storage/core.entity_registry
    '';
  };
}
