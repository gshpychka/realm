# Domain programs form one flat registry; lib.nix exposes their checked sources.
# The pinned HA compiler, strict renders, scope audit and fixtures run in
# home-assistant-config and in the host's build dependency. Contracts specify
# native output types and representative results for each declared program.
let
  entities = import ./entities.nix;
  literal = import ./template-literal.nix;
  mk =
    output: source:
    assert builtins.elem output [
      "text"
      "boolean"
      "integer"
      "number"
      "list"
      "mapping"
      "nullable-text"
      "number-or-unknown"
    ];
    assert builtins.isString source;
    {
      inherit output source;
    };
  fields =
    output: source: mk output ((builtins.readFile ./template-macros/safe-fields.jinja) + source);
  domains = [
    (import ./templates/system.nix {
      inherit
        entities
        literal
        mk
        fields
        ;
    })
    (import ./templates/printer.nix {
      inherit
        entities
        literal
        mk
        fields
        ;
    })
    (import ./templates/power.nix {
      inherit
        entities
        literal
        mk
        fields
        ;
    })
    (import ./templates/weather.nix {
      inherit
        entities
        literal
        mk
        fields
        ;
    })
    (import ./templates/media.nix {
      inherit mk fields;
    })
    (import ./templates/gpt.nix {
      inherit
        entities
        literal
        mk
        fields
        ;
    })
    (import ./templates/climate.nix {
      inherit entities literal mk;
    })
  ];
in
import ./merge-template-domains.nix domains
