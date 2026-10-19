{ lib }:
let
  ha = import ../../../../machines/home-assistant/configuration/lib.nix { inherit lib; };
  unchecked = builtins.readFile ../fixtures/templates/unchecked.jinja;
  template = import ../../../../machines/home-assistant/configuration/template.nix;
  files = import ../../../../machines/home-assistant/configuration/template-files.nix;
  rejects = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
  valid = {
    alias = "Fixture";
    triggers = [
      {
        trigger = "homeassistant";
        event = "start";
      }
    ];
    actions = [
      {
        action = "light.turn_on";
        target.entity_id = ha.entities.light.roomOverheadLights;
      }
    ];
  };
in
assert import ./button-triggers-test.nix { inherit lib; };
assert import ./lib-test.nix { inherit lib; };
assert rejects (ha.automation "opaque body");
assert rejects (ha.automation (valid // { id = "optional-id"; }));
assert rejects (ha.automation (valid // { actions = "opaque body"; }));
assert rejects (ha.automation (valid // { triggers = [ "opaque body" ]; }));
assert rejects (
  ha.action {
    action = "light.turn_on";
    delay.seconds = 2;
  }
);
assert rejects (ha.action { action = "not a service"; });
assert rejects (ha.action { variables = "opaque body"; });
assert rejects (
  ha.action {
    "if" = [ unchecked ];
    "then" = [ ];
  }
);
assert rejects (
  ha.condition {
    condition = "and";
    conditions = "opaque body";
  }
);
assert rejects (ha.condition ha.templates.message);
# Generating safe syntax does not exempt an unregistered reference from checks.
assert rejects (
  ha.action {
    set_conversation_response =
      (files.resolveProgram (
        template.ref [
          "trigger"
          "id"
        ]
        // {
          output = "text";
        }
      )).source;
  }
);
assert rejects (
  ha.script {
    alias = "Fixture";
    sequence = "opaque body";
  }
);
assert rejects (ha.helpers { timer.fixture = "opaque body"; });
assert rejects (
  ha.helpers {
    timer.fixture = {
      name = "Fixture";
      restore = "true";
    };
  }
);
assert rejects (
  ha.orderedVariables [
    {
      a = 1;
      b = 2;
    }
  ]
);
assert
  (ha.orderedVariables [
    { b = 1; }
    { a = 2; }
  ]) == [
    { variables.b = 1; }
    { variables.a = 2; }
  ];
builtins.deepSeq (ha.automation valid) true
