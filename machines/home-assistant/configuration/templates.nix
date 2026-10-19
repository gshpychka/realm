# Domain modules declare file provenance, JSON bindings and native output types.
# The central loader checks the complete file inventory before loading sources.
let
  entities = import ./entities.nix;
  files = import ./template-files.nix;
  merge = import ./merge-template-domains.nix;
  domains = [
    (import ./templates/system.nix { inherit entities; })
    (import ./templates/printer.nix { inherit entities; })
    (import ./templates/power.nix { inherit entities; })
    (import ./templates/weather.nix { inherit entities; })
    (import ./templates/media.nix)
    (import ./templates/gpt.nix { inherit entities; })
    (import ./templates/climate.nix { inherit entities; })
  ];
in
files.resolve (merge domains)
