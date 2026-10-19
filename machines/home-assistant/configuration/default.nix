{
  _module.args.ha = import ./lib.nix;
  imports = [
    ./automations/devices.nix
    ./automations/lighting.nix
    ./automations/media.nix
    ./automations/power.nix
    ./automations/system.nix
    ./automations/voice.nix
    ./scripts
    ./helpers.nix
    ./scenes.nix
    ./integrations.nix
  ];
}
