# Authored logic comes from files; a closed constructor emits simple references.
# Bindings substitute JSON data only into authored Jinja expressions.
let
  root = ./jinja;
  template = import ./template.nix;
  unique =
    values:
    builtins.attrNames (
      builtins.listToAttrs (
        map (name: {
          inherit name;
          value = true;
        }) values
      )
    );
  collect =
    directory: prefix:
    builtins.concatLists (
      builtins.attrValues (
        builtins.mapAttrs (
          name: type:
          let
            relative = prefix + name;
          in
          if type == "directory" then
            collect (directory + "/${name}") (relative + "/")
          else
            assert type == "regular" && builtins.match ".*\\.jinja" name != null;
            [ relative ]
        ) (builtins.readDir directory)
      )
    );
  inventory = collect root "";
  bind =
    source: bindings:
    let
      parts = builtins.split "(@@JSON_[A-Z][A-Z0-9_]*@@)" source;
      tokens = unique (
        builtins.concatLists (map (part: if builtins.isList part then part else [ ]) parts)
      );
      names = builtins.attrNames bindings;
      expected = map (name: "@@JSON_${name}@@") names;
      # Encoding twice keeps quotes, escapes, newlines and delimiters inside a
      # Jinja string. HA's from_json then recovers the original native value.
      values = map (name: builtins.toJSON (builtins.toJSON bindings.${name})) names;
      stripped = builtins.replaceStrings tokens (map (_: "") tokens) source;
    in
    assert builtins.isString source && builtins.isAttrs bindings;
    assert builtins.all (name: builtins.match "[A-Z][A-Z0-9_]*" name != null) names;
    assert tokens == expected;
    assert builtins.length (builtins.split "@@JSON_" stripped) == 1;
    builtins.replaceStrings expected values source;
  read =
    file:
    assert builtins.isString file && builtins.elem file inventory;
    builtins.readFile (root + "/${file}");
  checkInventory =
    files:
    assert unique files == unique inventory;
    true;
  resolve =
    declarations:
    let
      programs = builtins.attrValues declarations;
      files = map (item: item.file) (builtins.filter (item: item ? file) programs);
      helpers = builtins.concatLists (map (item: item.helpers or [ ]) programs);
    in
    assert builtins.length (unique files) == builtins.length files;
    assert checkInventory (files ++ helpers);
    builtins.mapAttrs (_: resolveProgram) declarations;
  resolveProgram =
    item:
    assert builtins.isAttrs item;
    assert builtins.elem item.output [
      "text"
      "boolean"
      "integer"
      "number"
      "list"
      "mapping"
      "nullable-text"
      "number-or-unknown"
    ];
    if item ? reference then
      assert
        builtins.attrNames item == [
          "output"
          "reference"
        ];
      let
        inherit (template.ref item.reference) reference;
      in
      {
        inherit (item) output;
        # jinja-generator: the path above contains validated identifiers only.
        source = "{{ ${builtins.concatStringsSep "." reference} }}";
        provenance = {
          kind = "reference";
          path = reference;
        };
      }
    else
      assert builtins.all (
        name:
        builtins.elem name [
          "output"
          "file"
          "bindings"
          "helpers"
        ]
      ) (builtins.attrNames item);
      let
        helpers = item.helpers or [ ];
        source =
          builtins.concatStringsSep "" (map (file: bind (read file) { }) helpers)
          + bind (read item.file) (item.bindings or { });
      in
      {
        inherit (item) output;
        inherit source;
        provenance = {
          kind = "file";
          inherit (item) file;
          inherit helpers;
        };
      };
in
{
  inherit
    bind
    read
    inventory
    checkInventory
    resolve
    resolveProgram
    ;
}
