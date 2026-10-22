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
        Built-in Pi tools applied when this role initializes its worker. Allowing Bash does not restrict
        which commands that tool can execute.
      '';
    };
    delegatesTo = mkOption {
      type = uniqueListOf name;
      default = [ ];
      description = ''
        Agent definition names recorded in the manifest and validated by the host catalog. Autonomous
        delegation dispatch is not implemented yet.
      '';
    };
    credentials = mkOption {
      type = uniqueListOf (types.strMatching "[a-zA-Z0-9][a-zA-Z0-9_.-]*");
      default = [ ];
      description = ''
        Credential profile names recorded in the manifest. Delivery is not implemented, so nonempty
        requests are rejected before launch. Credential values and host file paths are not accepted.
      '';
    };
  };
}
