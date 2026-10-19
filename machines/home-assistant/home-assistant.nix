{
  inputs,
  lib,
  pkgs,
  ...
}:
let
  haPkgs = import inputs.nixpkgs { system = pkgs.stdenv.hostPlatform.system; };
  packages = import ../../packages/home-assistant { pkgs = haPkgs; };
in
{
  imports = [ ./configuration ];

  services.home-assistant = {
    enable = true;
    package = packages.core;
    configDir = "/var/lib/hass";
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
      ln -sfn ${./yasno-address-guard} /var/lib/hass/pyscript/apps/yasno_address_guard
    '';
  };
}
