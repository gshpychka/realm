{ ha, ... }:
{
  services.home-assistant.config.script =
    (import ./devices.nix { inherit ha; })
    // (import ./media.nix { inherit ha; })
    // (import ./voice.nix { inherit ha; });
}
