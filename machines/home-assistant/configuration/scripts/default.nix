{ ha, ... }:
{
  services.home-assistant.config.script = builtins.mapAttrs (_: ha.script) (
    (import ./devices.nix { inherit ha; })
    // (import ./media.nix { inherit ha; })
    // (import ./voice.nix { inherit ha; })
  );
}
