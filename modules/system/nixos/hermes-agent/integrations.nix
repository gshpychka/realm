# Host capabilities for Hermes, kept under its own identity and state. The
# native terminal/process tools invoke pinned ACP clients and adapters. Only
# their package closure is shared with OpenClaw, never writable session/auth state.
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

  # Reuse the already locked ACP runtime closure: acpx 0.19.1, Claude's
  # adapter 0.79.0 and Codex's adapter 1.12.0. Explicit entry points avoid
  # acpx's built-in npx launchers and generic Linux binaries on NixOS.
  acpRuntime = pkgs.openclawRuntimePlugins.acpx;
  acpxEntry = "${acpRuntime}/node_modules/acpx/dist/cli.js";
  adapterEntry =
    agent: "${acpRuntime}/node_modules/@agentclientprotocol/${agent}-agent-acp/dist/index.js";
  claudeAdapterPath = "/etc/hermes-agent/claude-agent-acp";
  codexAdapterPath = "/etc/hermes-agent/codex-acp";
  scrubProviderEnvironment = ''
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
    unset OPENAI_API_KEY CODEX_API_KEY
  '';
  claudeAdapter = pkgs.writeShellApplication {
    name = "claude-agent-acp";
    text = ''
      ${scrubProviderEnvironment}
      export CLAUDE_CODE_EXECUTABLE=${lib.getExe pkgs.claude-code}
      exec ${lib.getExe pkgs.nodejs_24} ${adapterEntry "claude"} "$@"
    '';
  };
  codexAdapter = pkgs.writeShellApplication {
    name = "codex-acp";
    text = ''
      ${scrubProviderEnvironment}
      # Otherwise this adapter selects its bundled, non-Nix Linux executable.
      export CODEX_PATH=${lib.getExe pkgs.codex}
      exec ${lib.getExe pkgs.nodejs_24} ${acpRuntime}/node_modules/@agentclientprotocol/codex-acp/dist/index.js "$@"
    '';
  };
  acpClientScript = agent: adapter: ''
    ${scrubProviderEnvironment}
    ${lib.optionalString (agent == "claude") "export ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1"}
    exec ${lib.getExe pkgs.nodejs_24} ${acpxEntry} \
      --agent ${adapter} --format json --approve-all "$@"
  '';
  claudeAcp = pkgs.writeShellApplication {
    name = "hermes-claude-acp";
    text = acpClientScript "claude" claudeAdapterPath;
  };
  codexAcp = pkgs.writeShellApplication {
    name = "hermes-codex-acp";
    text = acpClientScript "codex" codexAdapterPath;
  };

  # These invoke the actual locked acpx implementation against a tiny local
  # ACP server. No provider credentials or remote model calls enter the check.
  acpCheck = pkgs.runCommand "hermes-acp-session-check" { nativeBuildInputs = [ pkgs.python3 ]; } ''
    cat > claude-client <<'EOF'
    #!${pkgs.runtimeShell}
    set -euo pipefail
    ${lib.replaceStrings [ claudeAdapterPath ] [ "$HERMES_ACP_TEST_ADAPTER" ] (
      acpClientScript "claude" claudeAdapterPath
    )}
    EOF
    cat > codex-client <<'EOF'
    #!${pkgs.runtimeShell}
    set -euo pipefail
    ${lib.replaceStrings [ codexAdapterPath ] [ "$HERMES_ACP_TEST_ADAPTER" ] (
      acpClientScript "codex" codexAdapterPath
    )}
    EOF
    chmod +x claude-client codex-client
    python ${../../../../scripts/hermes-agent/tests/acp_fixture.py} \
      --check "$PWD/claude-client" "$PWD/codex-client"
    test -s ${adapterEntry "claude"}
    test -s ${acpRuntime}/node_modules/@agentclientprotocol/codex-acp/dist/index.js
    touch "$out"
  '';

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
          config.nix.package
        ];
        nix.settings.allowed-users = [ cfg.user ];
        systemd.tmpfiles.rules = [
          "d ${repositories} 0700 ${cfg.user} ${config.users.users.${cfg.user}.group} - -"
        ];
        system.checks = [ acpCheck ];
      })

      (lib.mkIf cfg.claudeCode.enable {
        # The stable /etc command is also acpx's persisted session identity,
        # so updating the Nix package doesn't hide all pre-existing sessions.
        environment.etc."hermes-agent/claude-agent-acp".source = lib.getExe claudeAdapter;
        my.hermes-agent = {
          extraPackages = [
            pkgs.claude-code
            claudeAcp
          ];
          skills.claude-code-acp = {
            description = "Delegate coding to Claude Code through persistent ACP sessions: start, steer, poll and cancel.";
            text = ''
              `hermes-claude-acp` is the pinned acpx ACP client and Claude Code
              adapter, using your own Claude subscription login. The owner
              signs in once with `hermes-run claude` and `/login`.
              The wrapper clears inherited API credentials, loads your user,
              project and local Claude settings, and approves tools as the
              existing OpenClaw ACP integration does. Work within the owner's
              task. Claude uses its own defaults and your user/project settings;
              this deployment imposes no effort or Remote Control preferences.

              Start or recover a named repository session:

                  hermes-claude-acp --cwd <repository> sessions ensure --name <name>

              Store the task in a private prompt file, then call Hermes's
              `terminal` with `background=true` and `pty=false` for:

                  hermes-claude-acp --cwd <repository> prompt -s <name> --file <prompt-file>

              The returned process session_id tracks this invocation. Poll and
              read output using `process(action="poll", session_id="...")`
              and `process(action="log", session_id="...")`. Check the exit
              status and the NDJSON result before reporting completion.
              Steer or resume by running the same named prompt command again;
              an active ACP owner queues the follow-up, preserving context.
              `--no-wait` queues without waiting only when an owner is busy;
              it is not a substitute for Hermes background process mode.

                  hermes-claude-acp --cwd <repository> status -s <name>
                  hermes-claude-acp --cwd <repository> sessions history <name> --limit 20
                  hermes-claude-acp --cwd <repository> cancel -s <name>
                  hermes-claude-acp --cwd <repository> sessions close <name>

              ACP sessions and history persist under `${serviceHome}/.acpx`,
              independently of your foreground turn. A gateway restart can
              interrupt a running terminal process; reconnect to the persisted
              session and inspect status/history before resubmitting a prompt.
              Never automatically replay a task whose outcome is unknown.
              Use one name per workstream, keep checkouts under `${repositories}`,
              inspect diffs/tests, and tell the owner the result. There is no
              OpenClaw sessions_spawn callback; you must poll and report it.
            '';
          };
        };
        services.hermes-agent.environment.DISABLE_AUTOUPDATER = "1";
      })

      (lib.mkIf cfg.codex.enable {
        environment.etc."hermes-agent/codex-acp".source = lib.getExe codexAdapter;
        my.hermes-agent = {
          extraPackages = [
            pkgs.codex
            codexAcp
          ];
          skills.codex-acp = {
            description = "Run persistent Codex app-server sessions through ACP; start, resume, poll, steer and cancel coding work.";
            text = ''
              Codex is installed on PATH and runs as the Hermes service user.
              Authenticate once with
              `hermes-run env -u OPENAI_API_KEY -u CODEX_API_KEY codex login`, or
              have the owner securely migrate compatible Codex auth state to
              `${serviceHome}/.codex`. Hermes's own provider sign-in does not
              automatically sign the separate Codex CLI in.

              `hermes-codex-acp` runs acpx's pinned Codex adapter against the
              installed Nix Codex app-server. It clears inherited API keys to
              use that subscription, and approves ACP tools like OpenClaw's
              unattended coding path. Create/recover a named session:

                  hermes-codex-acp --cwd <repository> --model gpt-6.1-sol sessions ensure --name <name>
                  hermes-codex-acp --cwd <repository> set reasoning_effort xhigh -s <name>

              Write a private prompt file. Run the following through Hermes
              `terminal` with `background=true`, `pty=false`, then poll/log the
              returned process session_id and report the actual result:

                  hermes-codex-acp --cwd <repository> prompt -s <name> --file <prompt-file>

              The same prompt command resumes or queues a follow-up. Inspect
              the persistent session with `status -s <name>` and
              `sessions history <name> --limit 20`; cancel work using
              `cancel -s <name>`. `sessions close <name>` ends the workstream.
              All commands take the same `--cwd <repository>`. Session state is
              in `${serviceHome}/.acpx`; after a gateway/process interruption,
              inspect status/history before resubmitting ambiguous work.

              This gives Hermes a persistent Codex app-server coding worker;
              OpenClaw chat binding and its native session catalog are separate.
              The direct Codex CLI remains available for specialized commands.
              Keep checkouts under `${repositories}` and inspect diffs/tests
              before reporting success.
            '';
          };
        };
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
