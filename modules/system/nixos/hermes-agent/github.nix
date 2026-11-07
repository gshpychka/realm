# The agent's GitHub identity: git and gh in its commands act as one of this
# host's GitHub Apps.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hermes-agent;
  app = config.my.githubApps.${cfg.github};
  service = config.services.hermes-agent;
in
{
  options.my.hermes-agent.github = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "Slug of the my.githubApps App the agent acts as; null leaves the agent without GitHub credentials.";
  };

  config = lib.mkIf (service.enable && cfg.github != null) {
    # mkIf reads its body's attribute names even when github is null
    my.githubApps = lib.optionalAttrs (cfg.github != null) {
      ${cfg.github}.users = [ service.user ];
    };

    services.hermes-agent.extraPackages = [
      pkgs.git
      app.gh
    ];

    my.hermes-agent.skills.github-app = {
      description = "Clone, pull, commit and push to the owner's GitHub repositories, and open pull requests, as ${app.botName}.";
      text = ''
        `git` and `gh` act as the GitHub App ${app.botName}, over HTTPS, with no
        setup. The App writes to the repositories it is installed on and reads
        those and every public one; any other answers 404.

        Open pull requests with `gh pr create`.
      '';
    };
  };
}
