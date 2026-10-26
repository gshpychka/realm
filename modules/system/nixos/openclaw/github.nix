# The agent's GitHub identity: git and gh in its commands act as one of this
# host's GitHub Apps.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.openclaw;
  app = config.my.githubApps.${cfg.github};
  gw = config.services.openclaw-gateway;
in
{
  options.my.openclaw.github = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "Slug of the my.githubApps App the agent acts as; null leaves the agent without GitHub credentials.";
  };

  config = lib.mkIf (cfg.enable && cfg.github != null) {
    # mkIf reads its body's attribute names even when github is null
    my.githubApps = lib.optionalAttrs (cfg.github != null) {
      ${cfg.github}.users = [ gw.user ];
    };

    my.openclaw = {
      extraPackages = [
        pkgs.git
        app.gh
      ];
      skills.github-app = {
        description = "Clone, pull, commit and push to the owner's GitHub repositories, and open pull requests, as ${app.botName}.";
        text = ''
          `git` and `gh` act as the GitHub App ${app.botName}, over HTTPS, with no
          setup. The App writes to the repositories it is installed on and reads
          those and every public one; any other answers 404.

          Open pull requests with `gh pr create`.
        '';
      };
    };
  };
}
