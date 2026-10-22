# Role metadata is evaluated alongside the NixOS machine, but never installed into it.
{ lib, ... }:
let
  inherit (lib) mkOption types;
  name = types.strMatching "[a-zA-Z][a-zA-Z0-9_-]*";
  uniqueListOf = element: types.addCheck (types.listOf element) (values: lib.unique values == values);
in
{
  options.pituitary.agent = {
    description = mkOption {
      type = types.str;
      default = "";
      description = "Purpose of this agent, shown when choosing a definition.";
    };
    instructions = mkOption {
      type = types.lines;
      default = "";
      description = "Role instructions delivered to the worker at runtime, outside the machine image.";
    };
    model = mkOption {
      type = types.nullOr (types.strMatching "[^/[:space:]]+/[^[:space:]]+");
      default = null;
      description = "Provider/model identifier; null uses the worker's configured default.";
    };
    tools = mkOption {
      type = uniqueListOf (
        types.enum [
          "read"
          "bash"
          "edit"
          "write"
          "grep"
          "find"
          "ls"
        ]
      );
      default = [
        "read"
        "bash"
        "edit"
        "write"
      ];
      description = ''
        Requested built-in Pi tools recorded in the manifest. Applying this list requires runtime catalog
        support; it does not restrict shell commands.
      '';
    };
    delegatesTo = mkOption {
      type = uniqueListOf name;
      default = [ ];
      description = ''
        Requested agent definition names recorded in the manifest. Target resolution and delegation
        enforcement require runtime catalog support.
      '';
    };
    credentials = mkOption {
      type = uniqueListOf (types.strMatching "[a-zA-Z0-9][a-zA-Z0-9_.-]*");
      default = [ ];
      description = ''
        Requested credential profile names recorded in the manifest. Profile resolution and delivery
        require runtime catalog support; credential values and host file paths are not accepted.
      '';
    };
  };
}
