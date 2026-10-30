# Claude Code sessions the agent starts, steers and checks on through ACP
# (https://docs.openclaw.ai/tools/acp-agents), on the owner's personal Claude
# plan. Sessions run as the gateway user and run every tool without asking.
#
# Imperative, one-time: sign in to the personal Claude plan as the gateway
# user:
#   sudo -iu openclaw claude      # /login, then /exit
# Existing OAuth credentials remain writable; no re-login is needed to adopt HM.
# A reviewed NixOS/HM activation is required before these defaults take effect.
#
# Verified against HM 427c74a88a93cc9f856c8bb99bf6b4a5187a6b33 and Claude
# Code 2.1.296. Upstream setting names and precedence:
# https://code.claude.com/docs/en/settings-reference#effortlevel
# https://code.claude.com/docs/en/settings-reference#modelsettings
# https://code.claude.com/docs/en/remote-control#enable-remote-control-for-all-sessions
# Remote Control auto-connect applies to INTERACTIVE sessions, not headless
# Agent SDK/ACP queries. It is authenticated to the existing claude.ai account,
# requires an eligible subscription, and may require its one-time confirmation
# in an interactive session. This does not expose ports or bypass that consent.
# Headless ACP sessions are NOT thereby guaranteed visible in claude.ai/code.
# Project/local false can disable RC, and explicit effort/model choices or caps
# can override these defaults; future models need their own modelSettings entry.
# Models without xhigh support run at their highest supported level below it.
{
  config,
  lib,
  pkgs,
  options,
  ...
}:
let
  cfg = config.my.openclaw;
  gw = config.services.openclaw-gateway;
  # Claude Code's agent id in acpx's registry
  agentId = "claude";
  # where sessions clone repositories
  reposDir = "${cfg.workspace}/claude";
  gatewayHome = config.users.users.${gw.user}.home;
in
{
  options.my.openclaw.claudeCode.enable = lib.mkEnableOption "Claude Code sessions for the agent";

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        services.openclaw-gateway.config.acp = {
          # ACP is on unless set to false
          enabled = cfg.claudeCode.enable || cfg.codex.enable;
          # Built here in one list: gateway config merges with lib.recursiveUpdate,
          # where a second module's list would replace this one, not extend it.
          # "codex" is Codex's id in acpx's registry. The acpx backend, its
          # permission mode and the default agent below stay Claude Code's; with
          # Claude Code off, none of them is set.
          allowedAgents = lib.optional cfg.claudeCode.enable agentId ++ lib.optional cfg.codex.enable "codex";
        };
      }
      (lib.mkIf cfg.claudeCode.enable (
        lib.mkMerge [
          {
            assertions = [
              {
                assertion = options ? home-manager;
                message = "Assistant Claude settings require the NixOS Home Manager module.";
              }
            ];

            services.openclaw-gateway = {
              config = {
                acp = {
                  backend = "acpx";
                  defaultAgent = agentId;
                };
                plugins.entries.acpx = {
                  enabled = true;
                  # ACP sessions have no terminal to answer permission prompts on
                  config.permissionMode = "approve-all";
                };
              };
              # the Claude ACP adapter's own `claude` is a binary for generic Linux, which NixOS cannot run
              # Adapter 0.79.0 queries include user/project/local settingSources.
              # Keeping the upstream ~/.claude location means this explicit binary
              # reads HM settings without sourcing HM sessionVariables or a wrapper.
              environment.CLAUDE_CODE_EXECUTABLE = lib.getExe pkgs.claude-code;
            };

            my.openclaw = {
              extraPackages = [
                pkgs.jq
                pkgs.curl
                # for nix builds in sessions
                config.nix.package
              ];
              skills.claude-code = {
                description = "Start, steer and check on Claude Code sessions for coding work in git repositories.";
                text = ''
                  Hand coding work to Claude Code with `sessions_spawn`, `runtime:
                  "acp"` and `agentId: "${agentId}"`. Steer a running session with
                  `sessions_send`; `sessions_list` and `sessions_history` show where it
                  is. A finished run is announced back to you; tell the owner what it
                  did.

                  Sessions run as you, with network access, on the owner's personal
                  Claude plan. Always pass `cwd`, since a session without one starts in
                  your own workspace: `${reposDir}` to have it clone the repository
                  there, or the clone's directory, such as `${reposDir}/<repo>`, to
                  continue in one that exists.
                '';
              };
            };

            # the daemon admits only listed users
            nix.settings.allowed-users = [ gw.user ];

            systemd.tmpfiles.rules = [
              # tmpfiles creates a missing parent of a rule's path as root
              "d ${cfg.workspace} 0700 ${gw.user} ${gw.group} - -"
              "d ${reposDir} 0700 ${gw.user} ${gw.group} - -"
            ];
          }
          # Do not import the human's Home Manager profile. Merge into the existing
          # NixOS HM infrastructure, registering only the gateway service account.
          (lib.optionalAttrs (options ? home-manager) {
            home-manager.users.${gw.user} = {
              home = {
                username = gw.user;
                homeDirectory = gatewayHome;
                # First HM generation for this service account, not the host's age.
                stateVersion = "26.05";
              };
              programs.claude-code = {
                enable = true;
                package = pkgs.claude-code;
                # Keep ~/.claude (OAuth, sessions, plugins) and ~/.claude.json in place.
                # HM merges declared keys into a writable settings.json; undeclared
                # settings survive, and no credential or global-state file is managed.
                mutableSettings = true;
                settings = {
                  effortLevel = "xhigh";
                  # Since 2.1.251 effort is saved per model. User-level effortLevel
                  # is legacy-only on Opus 5.5 and later: cover today's newer models
                  # explicitly without pinning CLAUDE_CODE_EFFORT_LEVEL (which blocks
                  # changing effort through Remote Control).
                  modelSettings =
                    lib.genAttrs
                      [
                        "claude-opus-5-5"
                        "claude-sonnet-5-5"
                        "claude-haiku-5-5"
                      ]
                      (_: {
                        effortLevel = "xhigh";
                      });
                  remoteControlAtStartup = true;
                };
              };
            };

            assertions = [
              {
                assertion = lib.versionAtLeast (lib.getVersion pkgs.claude-code) "2.1.251";
                message = "Assistant Claude settings require per-model effort support (Claude Code >= 2.1.251).";
              }
            ];
          })
        ]
      ))
    ]
  );
}
