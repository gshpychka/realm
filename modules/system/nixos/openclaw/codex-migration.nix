# codex-migration: a second agent whose turns run in Codex's app-server, for
# main to spawn as a native subagent (sessions_spawn with agentId
# codex-migration, not runtime "acp": acp.allowedAgents stays claude's).
# It works on the Home Assistant migration: files and shell on this host as
# the gateway user, and the ha-mcp admin server's tools.
#
# Verified against OpenClaw e178c39e (source paths below) and its codex
# plugin 2026.10.1.
{ config, lib, ... }:
let
  cfg = config.my.openclaw;
  gw = config.services.openclaw-gateway;

  mainAgent = "main";
  agentId = "codex-migration";
  # The one model its turns run on. Main's primary today, but pinned here on
  # its own, so a change of main's model leaves the worker's alone.
  model = "openai/gpt-6.1-sol";

  # main's channels, each bound to it below. From the channel modules' own
  # options: the rendered config's bindings depend on these bindings.
  mainChannels = lib.optional cfg.telegram.enable "telegram";
in
{
  options.my.openclaw.codexMigration.enable = lib.mkEnableOption ''
    the codex-migration agent, which main spawns to work on the Home
    Assistant migration on Codex's runtime'';

  config = lib.mkIf (cfg.enable && cfg.codexMigration.enable) {
    assertions = [
      {
        assertion = cfg.codex.enable;
        message = "my.openclaw.codexMigration runs on Codex's runtime, which needs my.openclaw.codex.";
      }
      {
        # main's own Codex turns would no longer be OpenClaw's: models.nix runs them on OpenClaw's runtime
        assertion = gw.config.agents.defaults.models."openai/*".agentRuntime.id or null == "openclaw";
        message = "my.openclaw.codexMigration expects main's OpenAI turns on OpenClaw's runtime (models.nix).";
      }
      {
        # an unbound channel would have no agent
        assertion =
          lib.attrNames (lib.filterAttrs (_: channel: channel.enabled or true) (gw.config.channels or { }))
          == mainChannels;
        message = "my.openclaw.codexMigration binds main's channels, ${toString mainChannels}, but the gateway has others.";
      }
      {
        assertion = cfg.mcpServers ? home-assistant-admin;
        message = "my.openclaw.codexMigration's tools name the home-assistant-admin MCP server, which isn't configured.";
      }
    ];

    # A second agent makes the roster multi-agent, which OpenClaw accepts only
    # with explicit ownership (src/config/zod-schema.agents.ts): a
    # `default = true` marker fails `config validate`, and no key restores an
    # implicit default. What `openclaw doctor --fix` writes for main instead
    # (materializeLegacyDefaultAgentRoles, src/config/legacy.default-agent-roles.ts)
    # keeps every surface main owned implicitly main's:
    # - its workspace, pinned (unpinned, an agent's is <defaults.workspace>/<id>)
    # - every enabled channel, Telegram, as a channel-wide binding
    # - the system agent (agent-less cron jobs, workspace plugins, the Control
    #   UI's and gateway RPCs' agent when none is named), and talk
    # Not needed: heartbeat (agents.defaults sets it), authInheritance
    # (recorded only for an owner other than main) and sessionStore (only for
    # a fixed session.store; the default is per agent).
    # HTTP /v1/* requests then need x-openclaw-agent-id (src/gateway/http-utils.ts).
    # The voice broker names main on every request already: x-openclaw-agent-id
    # and agent:main:* session keys (voice-broker.nix).
    my.openclaw.bindings = map (channel: {
      agentId = mainAgent;
      match = {
        inherit channel;
        accountId = "*";
      };
    }) mainChannels;

    services.openclaw-gateway.config = {
      agents = {
        ownership = "explicit";
        defaults.systemAgent.agentId = mainAgent;
        entries = {
          ${mainAgent} = {
            inherit (cfg) workspace;
            # Spawn targets beyond itself, which is all it may spawn without this
            # list (src/agents/subagents/spawn/subagent-target-policy.ts).
            subagents.allowAgents = [
              mainAgent
              agentId
            ] ++ lib.optional cfg.claudeCode.enable "claude";
          };

          # Its workspace is unpinned: <agents.defaults.workspace>/codex-migration,
          # inside main's (resolveAgentWorkspaceDir, src/agents/agent-scope-config.ts).
          ${agentId} = {
            # No fallbacks: an explicit empty list overrides inherited ones
            # (resolveSelectedModelFallbacksOverride, src/agents/agent-scope.ts).
            model = {
              primary = model;
              fallbacks = [ ];
            };
            # A spawn takes the target's subagents.model before its primary
            # (resolveSubagentConfiguredModelSelection,
            # src/agents/model-selection-config.ts), so agents.defaults.subagents
            # can't swap it either.
            subagents = {
              model = {
                primary = model;
                fallbacks = [ ];
              };
              # A spawn takes the requester's subagents.thinking, then the
              # target's, before the requester's own level, which would replace
              # thinkingDefault (src/agents/subagents/spawn/subagent-spawn-thinking.ts).
              # main has none.
              thinking = "ultra";
              # it spawns nothing but itself
              allowAgents = [ ];
            };
            # A sessions_spawn `model` argument is checked against this
            # (resolveConfiguredModelPolicyAllow, src/agents/model-selection-shared.ts).
            modelPolicy.allow = [ model ];
            # Codex runs ultra itself (resolveCodexAppServerReasoningEffort,
            # extensions/codex/src/app-server/reasoning-effort.ts).
            thinkingDefault = "ultra";
            # Its exact model entry wins over models.nix's "openai/*" wildcard
            # (resolveModelRuntimePolicy, src/agents/model-runtime-policy.ts):
            # Codex's runtime, failing closed when Codex is unavailable.
            models.${model}.agentRuntime.id = "codex";
            # Auth: the shared openai:chatgpt profile and auth.order.openai, as
            # main's, handed to Codex in memory; no login of its own
            # (docs/plugins/codex-harness-reference/auth.md).

            tools = {
              # An allowlist, so a tool added later stays out until named here:
              # no messaging, cron, sessions, gateway, nixos_control or Home
              # Assistant's Assist server. A finite allowlist makes every turn
              # a restricted Codex turn (docs/plugins/codex-harness-reference/restricted-turns.md):
              # no native Code Mode, shell or MCP; OpenClaw's own file and shell
              # tools stand in (filterCodexDynamicToolsForDisabledNativeSurface,
              # extensions/codex/src/app-server/dynamic-tool-profile.ts), and the
              # allowed configured MCP tools become OpenClaw tools, through
              # OpenClaw's own MCP connection, so the admin server's URL never
              # reaches Codex.
              # Files outside its workspace too (tools.fs.workspaceOnly is off),
              # and the gateway's environment, SSH_AUTH_SOCK included (root.nix).
              allow = [
                "read"
                "write"
                "edit"
                "apply_patch"
                "exec"
                "process"
                "home-assistant-admin__*"
              ];
              # no /elevated exec; this can only narrow tools.elevated
              elevated.enabled = false;
            };
          };
        };
      };
      talk.agentId = mainAgent;
    };
  };
}
