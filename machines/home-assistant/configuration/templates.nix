# Domain modules declare file provenance, JSON bindings and native output types.
# The central loader checks the complete file inventory before loading sources.
let
  entities = import ./entities.nix;
  files = import ./template-files.nix;
  merge = import ./merge-template-domains.nix;
  domains = [
    (import ./system/templates.nix { inherit entities; })
    (import ./printer/templates.nix { inherit entities; })
    (import ./power/templates.nix { inherit entities; })
    (import ./weather/templates.nix { inherit entities; })
    (import ./media/templates.nix)
    (import ./gpt/templates.nix { inherit entities; })
    (import ./climate/templates.nix { inherit entities; })
  ];
in
files.resolve (merge domains)
