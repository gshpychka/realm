# Role metadata is evaluated alongside the NixOS machine, but never installed into it.
{ lib, ... }:
let
  inherit (lib) mkOption types;
  name = types.strMatching "[a-zA-Z][a-zA-Z0-9_-]*";
  uniqueListOf = element: types.addCheck (types.listOf element) (values: lib.unique values == values);
in
{
  options.dura.agent = {
    description = mkOption {
      type = types.str;
      default = "";
      description = "Purpose of this agent, shown when choosing a definition.";
    };
    instructions = mkOption {
      type = types.lines;
      default = "";
      description = "Host conversation instructions, kept outside the machine image.";
    };
    model = mkOption {
      type = types.nullOr (types.strMatching "[^/[:space:]]+/[^[:space:]]+");
      default = null;
      description = "Provider/model identifier; null uses the host's explicit DURA_MODEL default.";
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
        Native coding tools exposed to this role. Allowing Bash does not restrict
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
        Host credential profile names available to this role. Secret values stay on the host;
        only profile references enter the catalog.
      '';
    };
    verification = mkOption {
      default = null;
      type = types.nullOr (
        types.submodule {
          options = {
            agent = mkOption {
              type = name;
              description = "Declared agent machine used as a fresh independent verification environment.";
            };
            checks = mkOption {
              type =
                types.addCheck
                  (types.attrsOf (
                    types.submodule {
                      options = {
                        command = mkOption {
                          type = types.addCheck (types.listOf types.str) (
                            argv: argv != [ ] && builtins.length argv <= 128 && builtins.head argv != ""
                          );
                          description = "Exact argument vector executed in the integrated checkout, without a shell wrapper.";
                        };
                        timeoutMs = mkOption {
                          type = types.ints.between 1 1800000;
                          default = 300000;
                          description = "Maximum check execution time in milliseconds.";
                        };
                      };
                    }
                  ))
                  (
                    checks:
                    builtins.length (builtins.attrNames checks) >= 1
                    && builtins.length (builtins.attrNames checks) <= 32
                    && lib.all (key: builtins.match "[a-zA-Z0-9][a-zA-Z0-9_.-]*" key != null) (
                      builtins.attrNames checks
                    )
                  );
              description = "Named checks required before accepting this role's integrated code result.";
            };
          };
        }
      );
      description = "Host acceptance policy, kept outside the machine image.";
    };
  };
}
