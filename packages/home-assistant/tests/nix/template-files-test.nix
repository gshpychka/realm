let
  files = import ../../../../machines/home-assistant/configuration/template-files.nix;
  template = import ../../../../machines/home-assistant/configuration/template.nix;
  reference = value: files.resolveProgram (value // { output = "text"; });
  literal = builtins.readFile ../fixtures/templates/literal-round-trip.jinja;
  rejects = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
in
assert files.checkInventory files.inventory;
# Missing registration and missing files both fail the complete inventory.
assert rejects (files.checkInventory (builtins.tail files.inventory));
assert rejects (files.checkInventory (files.inventory ++ [ "system/missing.jinja" ]));
assert rejects (files.read "system/missing.jinja");
assert rejects (files.read "../templates/system.nix");
# Substitutions cannot silently omit or introduce a parameter.
assert rejects (files.bind literal { });
assert rejects (
  files.bind literal {
    VALUE = true;
    UNUSED = false;
  }
);
assert rejects (files.bind literal { value = true; });
assert rejects (files.bind (files.read "system/has-announcement.jinja") { VALUE = true; });
# A reference accepts identifiers, never an arbitrary Jinja expression.
assert template.variable "end_ts" == template.ref [ "end_ts" ];
assert
  (reference (
    template.ref [
      "trigger"
      "id"
    ]
  )).provenance == {
    kind = "reference";
    path = [
      "trigger"
      "id"
    ];
  };
assert builtins.all (name: rejects (reference (template.variable name))) [
  ""
  "1name"
  "two words"
  "trigger.id"
  "end_ts | int"
  "fn()"
  "a[0]"
  "a + b"
  "a\nb"
  "a\""
  "a'"
  "a\\b"
  # jinja-data: identifier injection must be rejected before source generation.
  "name }}{% set x = 1 %}{{ x"
  "true"
  "false"
  "none"
  "True"
  "False"
  "None"
  "if"
  "else"
  "for"
  "is"
  "in"
  "and"
  "or"
  "not"
  "recursive"
  null
  1
  false
  [ ]
  { }
];
assert builtins.all (path: rejects (reference (template.ref path))) [
  [ ]
  "trigger.id"
  null
  { }
  [ "" ]
  [
    "trigger"
    ""
  ]
  [
    "trigger"
    "id | int"
  ]
  [
    "trigger"
    "id.more"
  ]
  [
    "trigger"
    "id()"
  ]
  [
    "trigger"
    # jinja-data: attribute injection must be rejected before source generation.
    "x }}{% endif %}"
  ]
  [
    "trigger"
    1
  ]
  [
    "trigger"
    [ "id" ]
  ]
];
# Revalidate hand-built declarations and reject raw-source or mixed-file bypasses.
assert rejects (reference {
  reference = [ "a | int" ];
});
assert rejects (reference (template.variable "message" // { source = "raw source"; }));
assert rejects (
  reference (template.variable "message" // { file = "system/has-announcement.jinja"; })
);
assert rejects (reference (template.variable "message" // { bindings = { }; }));
assert rejects (reference (template.variable "message" // { helpers = [ ]; }));
assert rejects (files.resolveProgram (template.variable "message" // { output = "invalid"; }));
true
