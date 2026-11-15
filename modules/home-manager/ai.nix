{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.ai;
in
{
  options.my.ai = {
    enable = lib.mkEnableOption "AI tools and assistants";
  };

  config = lib.mkIf cfg.enable {
    home = {
      sessionVariables = {
        # https://code.claude.com/docs/en/env-vars
        # experimental flicker-free fullscreen renderer for claude-code
        CLAUDE_CODE_NO_FLICKER = "1";
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = "1";
        DISABLE_AUTOUPDATER = "1";
        DISABLE_TELEMETRY = "1";
        # https://code.claude.com/docs/en/agent-teams
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
        # https://code.claude.com/docs/en/model-config#adjust-effort-level
        # CLAUDE_CODE_EFFORT_LEVEL = "max";
        CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = "50000";
        # https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation
        CLAUDE_CODE_FORK_SUBAGENT = "1";
        CLAUDE_CODE_TMUX_TRUECOLOR = "1";
        # would disable "effort" and always use a static thinking budget
        # CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1";
        # needs to be combined with a thinking budget like this:
        # CLAUDE_CODE_MAX_THINKING_TOKENS = "50000";
      };

      # AI CLI/TUI tools from github:numtide/llm-agents.nix (via overlay)
      packages = with pkgs; [
        claude-code
        ccusage
        codex
        # gemini-cli
        # opencode
        # amp

        skills # from vercel-labs
      ];
    };
  };
}
