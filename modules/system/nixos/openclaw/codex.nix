# Codex (https://docs.openclaw.ai/plugins/codex-harness): a chat bound with
# `/codex bind` runs its turns in a Codex app-server, signed in with
# OpenClaw's OpenAI auth profile.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.openclaw;
in
{
  options.my.openclaw.codex.enable = lib.mkEnableOption "Codex sessions for the agent";

  config = lib.mkIf (cfg.enable && cfg.codex.enable) {
    my.openclaw.pluginPaths = [ "${pkgs.openclawRuntimePlugins.codex}" ];
    services.openclaw-gateway.config.plugins = {
      entries.codex = {
        enabled = true;
        config.appServer = {
          # every connection uses the agent's Codex home, the native session catalog's included
          homeScope = "agent";
          # API-key variables of the gateway's environment, which Codex signs in with when no auth profile applies
          clearEnv = [
            "CODEX_API_KEY"
            "OPENAI_API_KEY"
          ];
        };
      };
    };
    # The ACP dispatcher runs only registered agent ids; acp.allowedAgents
    # admitting "codex" (claude-code.nix) doesn't register it.
    services.openclaw-gateway.config.agents.entries.codex = {
      model = {
        primary = "openai/gpt-6.1-sol";
        # an explicit empty list overrides inherited fallbacks
        fallbacks = [ ];
      };
      thinkingDefault = "xhigh";
    };
  };
}
