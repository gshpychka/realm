{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hermes-agent;
in
{
  options.my.hermes-agent.skills = lib.mkOption {
    default = { };
    description = "Declarative fleet skills, installed under HERMES_HOME/skills/realm.";
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          description = lib.mkOption {
            type = lib.types.str;
            description = "When Hermes should load this skill.";
          };
          text = lib.mkOption {
            type = lib.types.lines;
            description = "The skill's Markdown instructions.";
          };
        };
      }
    );
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.mapAttrsToList (name: _: {
      assertion = builtins.match "[a-z0-9]+(-[a-z0-9]+)*" name != null;
      message = "Hermes skill names must contain lowercase letters, digits and hyphens.";
    }) cfg.skills;
    services.hermes-agent.hermesHomeFiles = lib.mapAttrs' (
      name: skill:
      lib.nameValuePair "skills/realm/${name}/SKILL.md" ''
        ---
        name: ${name}
        description: ${builtins.toJSON skill.description}
        ---
        ${skill.text}
      ''
    ) cfg.skills;

    # An independent age identity: never take OpenClaw's own key or change
    # its SOPS recipients. Enrol Hermes explicitly before using it for secrets.
    services.hermes-agent.environment.SOPS_AGE_KEY_FILE = "${cfg.stateDir}/age-key.txt";
    systemd.services.hermes-agent.preStart = ''
      if [ ! -e ${cfg.stateDir}/age-key.txt ]; then
        ${lib.getExe' pkgs.age "age-keygen"} -o ${cfg.stateDir}/age-key.txt
      fi
    '';
    my.hermes-agent = {
      extraPackages = [ pkgs.sops ];
      skills.sops = {
        description = "Use the agent's own age key for explicitly enrolled SOPS files.";
        text = ''
          SOPS_AGE_KEY_FILE points at your own private key. The owner must add
          its public recipient to .sops.yaml and run sops updatekeys before
          you can decrypt an existing file. See secrets/hermes/README.md.
          Do not copy OpenClaw's private key or print any decrypted value.
          Decrypt only the fields needed for an authorized task.
        '';
      };
    };
  };
}
