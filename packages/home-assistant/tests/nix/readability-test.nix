{ lib }:
let
  ha = import ../../../../machines/home-assistant/configuration/lib.nix { inherit lib; };
  merge = import ../../../../machines/home-assistant/configuration/merge-template-domains.nix;
  rejects = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
in
# Constructor extraction must not add private implementation helpers to the API.
assert
  builtins.attrNames ha == [
    "action"
    "announce"
    "areas"
    "automation"
    "call"
    "condition"
    "devices"
    "doublePress"
    "entities"
    "helpers"
    "longPress"
    "orderedVariables"
    "printerSnapshot"
    "quadruplePress"
    "quintuplePress"
    "script"
    "singlePress"
    "state"
    "templateContracts"
    "templates"
    "triplePress"
    "zha"
  ];
assert
  merge [
    { a = 1; }
    { b = 2; }
  ] == {
    a = 1;
    b = 2;
  };
assert rejects (merge [
  { a = 1; }
  { a = 2; }
]);
assert rejects (merge [
  { a = 1; }
  { a = 1; }
]);
true
