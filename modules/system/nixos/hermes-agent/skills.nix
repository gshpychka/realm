# Skills (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
# the agent reads when a task matches their description.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hermes-agent;
  service = config.services.hermes-agent;

  # one SKILL.md per skill directory
  skillsDir = pkgs.linkFarm "hermes-agent-skills" (
    lib.mapAttrsToList (name: skill: {
      name = "${name}/SKILL.md";
      path = pkgs.writeText "hermes-agent-skill-${name}" ''
        ---
        name: ${name}
        description: ${lib.generators.toYAML { } skill.description}
        ---
        ${skill.text}'';
    }) cfg.skills
  );
in
{
  options.my.hermes-agent.skills = lib.mkOption {
    default = { };
    description = "Skills the agent gets, keyed by skill name: lowercase letters, digits and hyphens.";
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          description = lib.mkOption {
            type = lib.types.str;
            description = "What the skill is for, listed in every prompt.";
          };
          text = lib.mkOption {
            type = lib.types.lines;
            description = "The skill's instructions, which the agent reads when its task matches the description.";
          };
        };
      }
    );
  };

  config = lib.mkIf service.enable {
    # read-only in the store; a skill of the same name in HERMES_HOME/skills wins
    services.hermes-agent.settings.skills.external_dirs = [ "${skillsDir}" ];
  };
}
