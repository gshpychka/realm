# All source code comes from files. Bindings substitute JSON data only; the
# parentheses and from_json filter belong to the authored Jinja expression.
let
  root = ./jinja;
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
      files = map (item: item.file) programs;
      helpers = builtins.concatLists (map (item: item.helpers or [ ]) programs);
    in
    assert builtins.length (unique files) == builtins.length files;
    assert checkInventory (files ++ helpers);
    builtins.mapAttrs (
      _: item:
      assert builtins.all (
        name:
        builtins.elem name [
          "output"
          "file"
          "bindings"
          "helpers"
        ]
      ) (builtins.attrNames item);
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
      let
        helpers = item.helpers or [ ];
        source =
          builtins.concatStringsSep "" (map (file: bind (read file) { }) helpers)
          + bind (read item.file) (item.bindings or { });
      in
      {
        inherit (item) output file;
        inherit helpers source;
      }
    ) declarations;
in
{
  inherit
    bind
    read
    inventory
    checkInventory
    resolve
    ;
}
