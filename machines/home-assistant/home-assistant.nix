{
  config,
  haPackages,
  inputs,
  lib,
  pkgs,
  ...
}:
{
  imports = [ ./configuration ];

  # The offline x86 check is a required build dependency, including when the
  # Pi closure is built separately from flake checks. It never sets up HA.
  system.extraDependencies = [
    (import ../../packages/home-assistant/tests {
      pkgs = inputs.nixpkgs.legacyPackages.x86_64-linux;
      configuration = config.services.home-assistant.config;
    })
  ];

  services.home-assistant = {
    enable = true;
    package = haPackages.core;
    configDir = "/var/lib/hass";
    extraComponents = haPackages.coreComponents;
    inherit (haPackages) customComponents;
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
    serviceConfig = {
      LoadCredential = [ "secrets.yaml:/var/lib/private/home-assistant/secrets.yaml" ];
      MemoryHigh = "2500M";
      MemoryMax = "3G";
    };
    path = [ pkgs.openssh ];
    preStart = lib.mkAfter ''
      ln -sfn "$CREDENTIALS_DIRECTORY/secrets.yaml" /var/lib/hass/secrets.yaml
      mkdir -p /var/lib/hass/pyscript/apps /var/lib/hass/yasno-address-guard /var/lib/hass/media
      # The app source is immutable; its transaction/recovery journal is state.
      ln -sfn ${./runtime/yasno-address-guard} /var/lib/hass/pyscript/apps/yasno_address_guard
    '';
  };
}
