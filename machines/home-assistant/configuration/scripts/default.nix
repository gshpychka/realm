{ lib, haDevices, ... }:
let
  definitions = import ./definitions.nix { inherit haDevices; };
  enabled = [
    "ask_gpt"
    "check_print"
    "game_mode"
    "set_air_conditioner_temperature"
  ];
in
{
  services.home-assistant.config.script = lib.filterAttrs (
    name: _: builtins.elem name enabled
  ) definitions;
}
