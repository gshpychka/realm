# GitHub Apps as GitHub identities of users on this host: their git and gh
# authenticate as the App and commit as <slug>[bot].
#
# Imperative, one-time per App, signed in to github.com as the owner:
#   1. Settings > Developer settings > GitHub Apps > New GitHub App: any
#      homepage URL, webhook off, "Only on this account"; repository
#      permissions Contents, Pull requests and Workflows read and write.
#      Note the App ID and the slug.
#   2. Generate a private key; in a checkout of this repository, store it
#      and delete the download:
#        jq -Rs . < key.pem | sops set --value-stdin <sopsFile> '["github-app-private-key"]'
#        rm key.pem
#   3. Install App > the owner's account > only select repositories. The
#      installation ID ends the installation's settings URL.
#   4. The bot user's ID:
#        curl -s 'https://api.github.com/users/<slug>%5Bbot%5D' | jq .id
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.githubApps;
  secrets = config.sops.secrets;
  # sops-nix secret names are host-global, so each carries the module's name
  secretName = slug: "github-app/${slug}";
  # the group that reads the App's private key
  groupName = slug: "github-app-${slug}";

  appTools =
    slug: app:
    let
      # Prints an installation token of the App.
      mintToken = pkgs.writeShellApplication {
        name = "github-app-${slug}-token";
        text = ''
          # base64url (--base64url) on one line (-w0), its padding removed (tr -d '='): a JWT's encoding of each part
          b64url() { ${lib.getExe' pkgs.coreutils "basenc"} --base64url -w0 | ${lib.getExe' pkgs.coreutils "tr"} -d '='; }
          # the current time as seconds since 1970 (+%s)
          now=$(${lib.getExe' pkgs.coreutils "date"} +%s)
          # the JWT's header: an RS256 signature
          header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
          # the JWT's claims: the App, issued a minute back for clock drift, expiring in 9 minutes within GitHub's 10
          payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" ${toString app.appId} | b64url)
          # the JWT's signature: header.payload hashed with SHA-256 and signed (-sign) with the App's key, as raw bytes (-binary)
          signature=$(printf '%s.%s' "$header" "$payload" | ${lib.getExe pkgs.openssl} dgst -sha256 -sign ${
            secrets.${secretName slug}.path
          } -binary | b64url)
          # the JWT as a request header, written to the pipe: process arguments are world-readable
          printf 'Authorization: Bearer %s.%s.%s\n' "$header" "$payload" "$signature" |
            # a POST (-X) exchanging it for an installation token, headers read from the pipe (-H @-), quiet but for errors (-sS), failing on an HTTP error (-f)
            ${lib.getExe pkgs.curl} -fsS -X POST -H @- -H 'Accept: application/vnd.github+json' https://api.github.com/app/installations/${toString app.installationId}/access_tokens |
            # the response's token as plain text (-r), failing when it has none (-e)
            ${lib.getExe pkgs.jq} -er .token
        '';
      };

      # a git credential helper (https://git-scm.com/docs/gitcredentials#_custom_helpers)
      credentialHelper = pkgs.writeShellScript "github-app-${slug}-git-credential" ''
        # whether git asks for credentials (get), the one request of the protocol that needs an answer
        if [ "$1" = get ]; then
          # the user name GitHub takes with an App token, and a fresh token as the password
          printf 'username=x-access-token\npassword=%s\n' "$(${lib.getExe mintToken})"
        fi
      '';
    in
    {
      gh = pkgs.writeShellApplication {
        name = "gh";
        text = ''
          # a fresh installation token, in the variable gh signs in with
          GH_TOKEN=$(${lib.getExe mintToken})
          # the variable handed on to gh
          export GH_TOKEN
          # gh itself in place of this shell (exec), the arguments passed on
          exec ${lib.getExe pkgs.gh} "$@"
        '';
      };

      gitConfig = pkgs.writeText "github-app-${slug}-gitconfig" (
        lib.generators.toGitINI {
          user = {
            name = app.botName;
            email = "${toString app.botUserId}+${app.botName}@users.noreply.github.com";
          };
          credential."https://github.com".helper = "${credentialHelper}";
          # the App authenticates over HTTPS only
          url."https://github.com/".insteadOf = [
            "git@github.com:"
            "ssh://git@github.com/"
          ];
        }
      );
    };
in
{
  options.my.githubApps = lib.mkOption {
    default = { };
    description = "GitHub Apps users on this host act as in git and gh, keyed by the App's URL name, as in github.com/apps/<slug>.";
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, config, ... }:
        let
          tools = appTools name config;
        in
        {
          options = {
            appId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "The App's ID.";
            };
            installationId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "The ID of the App's installation on the owner's account.";
            };
            botUserId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "The GitHub user ID of <slug>[bot], the account the App's commits link to.";
            };
            sopsFile = lib.mkOption {
              type = lib.types.path;
              description = "SOPS file holding the App's private key as github-app-private-key.";
            };
            users = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Users whose git and gh act as the App.";
            };
            botName = lib.mkOption {
              type = lib.types.str;
              readOnly = true;
              default = "${name}[bot]";
              description = "The App's GitHub account, which its commits name.";
            };
            gh = lib.mkOption {
              type = lib.types.package;
              readOnly = true;
              default = tools.gh;
              description = "gh, signed in as the App.";
            };
            gitConfig = lib.mkOption {
              type = lib.types.path;
              readOnly = true;
              default = tools.gitConfig;
              description = "A git config committing as the App and authenticating to github.com as it.";
            };
          };
        }
      )
    );
  };

  config = {
    sops.secrets = lib.mapAttrs' (
      slug: app:
      lib.nameValuePair (secretName slug) {
        inherit (app) sopsFile;
        key = "github-app-private-key";
        group = groupName slug;
        mode = "0440";
      }
    ) cfg;

    users.groups = lib.mapAttrs' (
      slug: app: lib.nameValuePair (groupName slug) { members = app.users; }
    ) cfg;

    systemd.tmpfiles.rules = lib.concatLists (
      lib.mapAttrsToList (
        _: app:
        map (user: "L+ ${config.users.users.${user}.home}/.gitconfig - - - - ${app.gitConfig}") app.users
      ) cfg
    );
  };
}
