# Imperative, one-time, with the YubiKey or the op age key: create the agent's
# sops file, then set its own credentials in it:
#   printf '{}\n' | sops encrypt --filename-override secrets/hoard/hermes.yaml > secrets/hoard/hermes.yaml
#   sops set secrets/hoard/hermes.yaml '["openai-api-key"]' '"<key>"'
#   sops set secrets/hoard/hermes.yaml '["elevenlabs-api-key"]' '"<key>"'
#   sops set secrets/hoard/hermes.yaml '["home-assistant-token"]' '"<long-lived token of a dedicated HA user>"'
#
# Imperative, one-time, after the first start: sign in to the owner's ChatGPT
# subscription for the agent's model, and to Claude and Codex for its coding
# sessions, each as the service user:
#   sudo -iu hermes hermes auth add openai-codex
#   sudo -iu hermes claude        # /login, then /exit
#   sudo -iu hermes codex login --device-auth
{ config, pkgs, ... }:
{
  services.hermes-agent = {
    enable = true;
    settings = {
      # commands run without asking
      approvals.mode = "off";
      model = {
        provider = "openai-codex";
        default = "gpt-6.1-sol";
      };
      stt.provider = "elevenlabs";
      tts = {
        provider = "elevenlabs";
        elevenlabs = {
          model_id = "eleven_v4";
          voice_id = "pMsXgVXv3BLzUgSXRplE";
        };
      };
    };

    # HA's MCP Server integration: the Assist API over the entities exposed
    # to it, as a dedicated HA user
    mcpServers.home-assistant = {
      url = "http://homeassistant.${config.my.domain}:8123/api/mcp";
      headers.Authorization = "Bearer \${HOME_ASSISTANT_TOKEN}";
    };
    # The ha-mcp app (https://homeassistant-ai.github.io/ha-mcp/), for HA
    # administration; its URL path is its only credential.
    mcpServers.home-assistant-admin.url = "http://homeassistant.${config.my.domain}:9583/\${HOME_ASSISTANT_ADMIN_MCP_PATH}";

    extraPackages = [
      pkgs.claude-code
      pkgs.codex
      # interactive Claude Code sessions
      pkgs.tmux
    ];
  };

  my.hermes-agent = {
    sopsFile = ../../secrets/hoard/hermes.yaml;
    secrets = {
      OPENAI_API_KEY = "openai-api-key";
      ELEVENLABS_API_KEY = "elevenlabs-api-key";
      HOME_ASSISTANT_TOKEN = "home-assistant-token";
    };
    hostSecrets.HOME_ASSISTANT_ADMIN_MCP_PATH = "home-assistant-admin-mcp-path";
    publicHost = config.services.nginx.virtualHosts.hermes.serverName;
    telegram.enable = true;
    onedrive.enable = true;
    root = {
      publicKey = config.my.sshKeys.hoardTpm;
      agentSocket = config.my.tpmSshKey.socket;
    };
  };

  my.tpmSshKey.extraUsers = [ config.services.hermes-agent.user ];

  systemd.services = {
    hermes-agent.serviceConfig = {
      # the gateway and the sessions it spawns stay within 3 of hoard's 15 GB
      MemoryMax = "3G";
      # a runaway command's processes stop well short of the host's limit
      TasksMax = 512;
    };
    # the dashboard and its terminals
    hermes-backend.serviceConfig = {
      MemoryMax = "1G";
      TasksMax = 256;
    };
  };
}
