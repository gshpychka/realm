{
  config,
  lib,
  pkgs,
  ...
}:
let
  service = config.services.hermes-agent;
in
{
  services.hermes-agent = {
    enable = true;
    settings = {
      approvals.mode = "off";
      agent.service_tier = "fast";
      model = {
        provider = "openai-codex";
        default = "gpt-6.1-sol";
      };
      # OpenRouter's speech endpoints use the OpenAI API format.
      stt = {
        provider = "openai";
        openai = {
          base_url = "https://openrouter.ai/api/v1";
          api_key = "\${OPENROUTER_API_KEY}";
          model = "openai/whisper-large-v3-turbo";
        };
      };
      tts = {
        provider = "openai";
        openai = {
          base_url = "https://openrouter.ai/api/v1";
          api_key = "\${OPENROUTER_API_KEY}";
          model = "elevenlabs/eleven-v4";
          voice = "pMsXgVXv3BLzUgSXRplE";
        };
      };
    };
    mcpServers = {
      home-assistant = {
        url = "http://homeassistant.${config.my.domain}:8123/api/mcp";
        headers.Authorization = "Bearer \${HOME_ASSISTANT_TOKEN}";
      };
      home-assistant-admin.url = "http://homeassistant.${config.my.domain}:9583/\${HOME_ASSISTANT_ADMIN_MCP_PATH}";
    };
    extraPackages = [
      pkgs.claude-code
      pkgs.codex
      pkgs.tmux
    ];
  };

  my.hermes-agent = {
    sopsFile = ../../secrets/hoard/hermes.yaml;
    secrets = {
      OPENROUTER_API_KEY = "openrouter-api-key";
      HOME_ASSISTANT_TOKEN = "home-assistant-token";
      HOME_ASSISTANT_ADMIN_MCP_PATH = "home-assistant-admin-mcp-path";
    };
    publicHost = config.services.nginx.virtualHosts.hermes.serverName;
    telegram.enable = true;
    github = "calcifer-hermes";
    onedrive.enable = true;
    root = {
      publicKey = config.my.sshKeys.hermes;
      agentSocket = "/run/hermes-ssh-agent/agent.sock";
    };
  };

  my.githubApps = lib.mkIf service.enable {
    calcifer-hermes = {
      appId = 5658518;
      installationId = 179633364;
      botUserId = 353816114;
      sopsFile = config.my.hermes-agent.sopsFile;
    };
  };
}
