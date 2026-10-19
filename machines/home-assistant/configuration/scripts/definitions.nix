{ haDevices }:
(import ./media.nix { inherit haDevices; }) // (import ./voice.nix) // (import ./devices.nix)
