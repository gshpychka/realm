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
        Agent definitions this role may ask the runtime to delegate to. The host validates these
        references and intersects them with the run's authority and resource limits.
      '';
    };
    limits = {
      maxChildren = mkOption {
        type = types.ints.unsigned;
        default = 1;
        description = "Maximum child tasks this role may create; zero disables delegation.";
      };
      maxDepth = mkOption {
        type = types.ints.unsigned;
        default = 1;
        description = "Maximum further delegation depth; descendants inherit the remaining allowance.";
      };
    };
    credentials = mkOption {
      type = uniqueListOf (types.strMatching "[a-zA-Z0-9][a-zA-Z0-9_.-]*");
      default = [ ];
      description = ''
        Host credential profile names available to this role. Values arrive through the private
        runtime connection and stay outside the role manifest and saved program history.
      '';
    };
  };
}
