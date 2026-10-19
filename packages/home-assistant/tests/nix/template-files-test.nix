let
  files = import ../../../../machines/home-assistant/configuration/template-files.nix;
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
assert rejects (files.bind (files.read "system/message.jinja") { VALUE = true; });
true
