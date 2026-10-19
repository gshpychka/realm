# Host capabilities for Hermes, kept under its own identity and state.
# Coding uses Hermes's bundled Claude Code and Codex CLI skills.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hermes-agent;
  app = cfg.github;
  serviceHome = config.users.users.${cfg.user}.home;
  repositories = "${cfg.stateDir}/workspace/repositories";
  githubSecret = "hermes/github-app-private-key";

  mintToken = pkgs.writeShellApplication {
    name = "hermes-github-token";
    text = ''
      b64url() { ${lib.getExe' pkgs.coreutils "basenc"} --base64url -w0 | ${lib.getExe' pkgs.coreutils "tr"} -d '='; }
      now=$(${lib.getExe' pkgs.coreutils "date"} +%s)
      header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
      payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" ${toString app.appId} | b64url)
      signature=$(printf '%s.%s' "$header" "$payload" | ${lib.getExe pkgs.openssl} dgst -sha256 -sign ${
        config.sops.secrets.${githubSecret}.path
      } -binary | b64url)
      # The JWT is passed over stdin rather than exposed in process arguments.
      printf 'Authorization: Bearer %s.%s.%s\n' "$header" "$payload" "$signature" |
        ${lib.getExe pkgs.curl} -fsS -X POST -H @- -H 'Accept: application/vnd.github+json' \
          https://api.github.com/app/installations/${toString app.installationId}/access_tokens |
        ${lib.getExe pkgs.jq} -er .token
    '';
  };

  credentialHelper = pkgs.writeShellScript "hermes-github-git-credential" ''
    set -eu
    [ "''${1:-}" = get ] || exit 0
    protocol=
    host=
    while IFS='=' read -r name value; do
      [ -n "$name" ] || break
      case "$name" in
        protocol) protocol=$value ;;
        host) host=$value ;;
      esac
    done
    # Never supply a GitHub App credential to another origin, including HTTP
    # or a GitHub-looking hostname. The helper remains scoped even when called
    # directly or by a repository with a different URL.
    [ "$protocol" = https ] && [ "$host" = github.com ] || exit 0
    token=$(${lib.getExe mintToken})
    printf 'username=x-access-token\npassword=%s\n' "$token"
  '';

  gh = pkgs.writeShellApplication {
    name = "gh";
    text = ''
      GH_TOKEN=$(${lib.getExe mintToken})
      export GH_TOKEN
      exec ${lib.getExe pkgs.gh} "$@"
    '';
  };

  botName = "${app.slug}[bot]";
  gitConfig = pkgs.writeText "hermes-gitconfig" (
    lib.generators.toGitINI {
      user = {
        name = botName;
        email = "${toString app.botUserId}+${botName}@users.noreply.github.com";
      };
      credential."https://github.com".helper = "${credentialHelper}";
      url."https://github.com/".insteadOf = [
        "git@github.com:"
        "ssh://git@github.com/"
      ];
    }
  );

  # Exercise the actual helper with a harmless minting fixture. This checks
  # both the accepted request and origins that must never receive a token,
  # without contacting GitHub or requiring a private key during a build.
  credentialScopeCheck = pkgs.runCommand "hermes-github-credential-scope-check" { } ''
    mkdir bin
    cat > bin/mint <<'EOF'
    #!${pkgs.runtimeShell}
    printf '%s\n' fixture-installation-token
    EOF
    chmod +x bin/mint
    ${pkgs.gnused}/bin/sed 's|${lib.getExe mintToken}|./bin/mint|g' ${credentialHelper} > helper
    chmod +x helper
    expected=$(printf 'username=x-access-token\npassword=fixture-installation-token')
    actual=$(printf 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n' | ./helper get)
    test "$actual" = "$expected"
    for request in \
      'protocol=http\nhost=github.com\n\n' \
      'protocol=https\nhost=github.com.attacker.example\n\n' \
      'protocol=https\nhost=example.com\n\n' \
      'protocol=https\n\n' \
      'host=github.com\n\n'; do
      test -z "$(printf '%b' "$request" | ./helper get)"
    done
    test -z "$(printf 'protocol=https\nhost=github.com\n\n' | ./helper store)"
    test -z "$(printf 'protocol=https\nhost=github.com\n\n' | ./helper erase)"
    touch "$out"
  '';
in
{
  options.my.hermes-agent = {
    github = lib.mkOption {
      default = null;
      description = "Hermes's GitHub App identity; null leaves GitHub unauthenticated.";
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            appId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "GitHub App ID.";
            };
            installationId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "Installation on the owner's account.";
            };
            slug = lib.mkOption {
              type = lib.types.nonEmptyStr;
              description = "GitHub App slug, without the [bot] suffix.";
            };
            botUserId = lib.mkOption {
              type = lib.types.ints.positive;
              description = "Numeric user ID of the App's bot account.";
            };
          };
        }
      );
    };

    onedrive.enable = lib.mkEnableOption "read and write access to the owner's synced OneDrive";
    claudeCode.enable = lib.mkEnableOption "the native Claude Code CLI for coding tasks";
    codex.enable = lib.mkEnableOption "the native Codex CLI for coding tasks";

    root = lib.mkOption {
      default = null;
      description = "An explicitly provisioned SSH-agent key for sudo; null grants no general root access.";
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            publicKey = lib.mkOption {
              type = lib.types.singleLineStr;
              description = "Public key accepted by pam_ssh_agent_auth for Hermes.";
            };
            agentSocket = lib.mkOption {
              type = lib.types.str;
              description = "SSH agent socket accessible to Hermes; provision independently of OpenClaw's private socket.";
            };
          };
        }
      );
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf (app != null) {
        sops.secrets.${githubSecret} = {
          inherit (cfg) sopsFile;
          key = "github-app-private-key";
          owner = cfg.user;
        };
        systemd.tmpfiles.rules = [
          "L+ ${serviceHome}/.gitconfig - - - - ${gitConfig}"
        ];
        my.hermes-agent = {
          extraPackages = [
            pkgs.git
            gh
          ];
          skills.github-app = {
            description = "Clone, pull, commit, push and open pull requests as ${botName}.";
            text = ''
              Git and gh authenticate as the GitHub App ${botName} over HTTPS.
              They mint short-lived installation tokens automatically. Access is
              limited to repositories where the owner has installed the App;
              public repositories remain readable. Use `gh pr create` for a PR.

              Keep checkouts under `${repositories}` and reuse an existing
              checkout when continuing work on the same repository.
            '';
          };
        };
        system.checks = [ credentialScopeCheck ];
      })

      (lib.mkIf cfg.onedrive.enable {
        assertions = [
          {
            assertion = config.my.onedrive.enable;
            message = "my.hermes-agent.onedrive.enable requires the existing my.onedrive sync service.";
          }
        ];
        users.users.${cfg.user}.extraGroups = [ config.my.onedrive.group ];
        systemd.services.hermes-agent.serviceConfig.ReadWritePaths = [ config.my.onedrive.syncDir ];
        systemd.services.hermes-backend = lib.mkIf cfg.dashboard.enable {
          serviceConfig.ReadWritePaths = [ config.my.onedrive.syncDir ];
        };
        my.hermes-agent.skills.onedrive = {
          description = "Read, write and organize the owner's OneDrive at ${config.my.onedrive.syncDir}.";
          text = ''
            `${config.my.onedrive.syncDir}` is the owner's OneDrive, synced both
            ways. A local change reaches OneDrive within seconds; remote changes
            arrive within ${toString (config.my.onedrive.pollInterval / 60)} minutes.
            Use normal file tools. Import files with
            `install -m 660 -g ${config.my.onedrive.group} <file> <directory>/`
            so the sync can read them. Moving an existing file can preserve
            permissions that deny the sync access.

            Deletions affect the owner's cloud files. OneDrive's recycle bin
            retains them for 30 days. Deleting a folder containing
            ${toString config.my.onedrive.bigDeleteThreshold} items or more,
            including the folder, pauses sync for the owner's confirmation.
          '';
        };
      })

      (lib.mkIf (cfg.claudeCode.enable || cfg.codex.enable) {
        my.hermes-agent.extraPackages = [
          pkgs.git
          pkgs.jq
          pkgs.curl
          pkgs.tmux
          config.nix.package
        ];
        nix.settings.allowed-users = [ cfg.user ];
        systemd.tmpfiles.rules = [
          "d ${repositories} 0700 ${cfg.user} ${config.users.users.${cfg.user}.group} - -"
        ];
      })

      (lib.mkIf cfg.claudeCode.enable {
        my.hermes-agent.extraPackages = [ pkgs.claude-code ];
        services.hermes-agent.environment.DISABLE_AUTOUPDATER = "1";
      })

      (lib.mkIf cfg.codex.enable {
        my.hermes-agent.extraPackages = [ pkgs.codex ];
      })

      (lib.mkIf (cfg.root != null) {
        services.hermes-agent.environment.SSH_AUTH_SOCK = cfg.root.agentSocket;
        security.pam.sshAgentAuth.enable = true;
        security.sudo.extraRules = [
          {
            users = [ cfg.user ];
            commands = [ "ALL" ];
          }
        ];
        users.users.${cfg.user}.openssh.authorizedKeys.keys = [ cfg.root.publicKey ];
        my.hermes-agent.skills.host-administration = {
          description = "Administer ${config.networking.hostName} using explicitly provisioned SSH-agent-authenticated sudo.";
          text = ''
            Your configured SSH agent authenticates sudo on this host. Use
            `sudo -n` so a missing or inaccessible key fails without hanging.
            This is full root access; use it only within the owner's request.

            The host's `nixos-switch build <full-sha>` and
            `sudo -n nixos-switch switch <full-sha>` operate only on commits
            already on the canonical repository's main branch. Inspect the
            journal for completion; never repeat an ambiguous activation.
          '';
        };
      })
    ]
  );
}
