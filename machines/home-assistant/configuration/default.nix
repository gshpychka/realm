{ lib, ... }:
{
  _module.args.ha = import ./lib.nix { inherit lib; };
  imports = [
    ./devices/automations.nix
    ./lighting/automations.nix
    ./media/automations.nix
    ./power/automations.nix
    ./printer/automations.nix
    ./system/automations.nix
    ./voice/automations.nix
    ./weather/automations.nix
    ./climate/scripts.nix
    ./gpt/scripts.nix
    ./media/scripts.nix
    ./printer/scripts.nix
    ./helpers.nix
    ./scenes.nix
    ./integrations.nix
  ];
}
