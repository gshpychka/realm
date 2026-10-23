{
  config,
  lib,
  pkgs,
  osConfig,
  ...
}:
let
  cfg = config.my.pi;
in
{
  options.my.pi = {
    enable = lib.mkEnableOption "pi coding agent";
    pituitary.enable = lib.mkEnableOption "pituitary, the OpenTUI frontend for pi";
  };

  config = lib.mkIf cfg.enable {
    programs.pituitary.enable = cfg.pituitary.enable;

    programs.pi-coding-agent = {
      enable = true;
      # llm-agents.nix tracks pi releases closely; nixpkgs lags
      package = pkgs.pi;

      # store-owned: pi's own writes via /settings, `pi install`, and `pi config` are dropped
      settings = {
        defaultProvider = "anthropic";
        defaultModel = "claude-opus-5-5";
        defaultThinkingLevel = "xhigh";
        warnings.anthropicExtraUsage = false;
        theme = "gruvbox-dark";
        packages = with pkgs.piPackages.sources; [
          pi-lens
          pi-mcp-adapter
          pi-web-access
          pi-subagents
          pi-plan-mode
          pi-rewind
          pi-automode
          pi-todo
          pi-ask-user-question
          pi-statusline
          pi-claude-agent-sdk
        ];
        # resource paths leave configDir/extensions to per-package config such as pi-automode's
        extensions = [ "${./config/extensions}" ];
        prompts = [ "${./config/prompts}" ];
        themes = [ "${./config/themes}" ];
        # ctrl+P cycles through these
        enabledModels = [
          "anthropic/*"
          "claude-bridge/*" # Claude Code through pi-claude-agent-sdk
          "openai/*" # ChatGPT subscription
          "ollama/*"
        ];
      };

      keybindings = {
        "app.session.new" = "alt+n";
        "app.session.resume" = "alt+r";
        "app.session.fork" = "alt+f";
      };

      models.providers.ollama = {
        baseUrl = osConfig.my.ollama.baseUrl;
        api = "openai-completions";
        # ollama ignores the key; pi hides models from providers with no credential
        apiKey = "ollama";
        compat = {
          supportsDeveloperRole = false;
          supportsReasoningEffort = false;
        };
        models = [
          { id = "qwen3.5:9b-q8_0"; }
          { id = "qwen3.8:27b-mtp-q4_K_M"; }
        ];
      };

      context = ./config/AGENTS.md;
    };

    # store-owned: `/automode model` cannot save here, so the classifier is picked below
    # https://github.com/czottmann/pi-automode/blob/main/docs/configuration.md
    home.file."${config.programs.pi-coding-agent.configDir}/extensions/pi-automode/config.json".text =
      builtins.toJSON
        {
          autoMode = {
            classifierModel = "anthropic/claude-haiku-5-5";
            fastClassifierMaxTokens = 1024;
            # in-tree file tools skip the classifier; protected paths (.git, .pi, dotfiles) still reach it
            allowInsideWorkingDirectory = true;
          };
        };

    # https://pi.dev/packages/pi-claude-agent-sdk
    home.file."${config.programs.pi-coding-agent.configDir}/claude-bridge.json".text = builtins.toJSON {
      # set explicitly, which also silences the startup notice asking for it
      plan = "max";
      pathToClaudeCodeExecutable = lib.getExe pkgs.claude-code;
    };
  };
}
