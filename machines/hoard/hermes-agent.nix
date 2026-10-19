# A separate agent alongside OpenClaw. Shared credentials are read from
# SOPS under the Hermes identity; Telegram needs a different bot while both run.
{ config, lib, ... }:
{
  my.hermes-agent = {
    enable = true;
    sopsFile = ../../secrets/hoard/openclaw.yaml;
    dashboard = {
      enable = true;
      publicHost = "hermes.${config.networking.fqdn}";
    };
    telegram.enable = true;
    # Optional, root-provisioned file for a dedicated bot and voice identity.
    # /etc/hermes-agent/telegram.env.example documents the non-secret shape.
    environmentFiles = [ "-/var/lib/hermes/telegram.env" ];
    secrets = {
      OPENAI_API_KEY = "openai-api-key";
      ELEVENLABS_API_KEY = "elevenlabs-api-key";
      HOME_ASSISTANT_TOKEN = "home-assistant-token";
      HOME_ASSISTANT_ADMIN_MCP_PATH = "home-assistant-admin-mcp-path";
      TELEGRAM_ALLOWED_USERS = "telegram-owner-id";
    };
    github = config.my.openclaw.github;
    codex.enable = true;
    claudeCode.enable = true;
    onedrive.enable = true;
    # Explicitly share the existing host signing identity, without changing
    # the TPM agent's owner or moving the non-exportable private key.
    root = {
      publicKey = config.my.sshKeys.openclaw;
      agentSocket = config.my.tpmSshKey.socket;
    };
  };

  my.tpmSshKey.extraUsers = lib.mkIf config.my.hermes-agent.enable [ config.my.hermes-agent.user ];
  systemd.services.hermes-agent = lib.mkIf config.my.hermes-agent.enable {
    after = [ "tpm-ssh-agent.service" ];
    wants = [ "tpm-ssh-agent.service" ];
  };

  services.hermes-agent = {
    settings = {
      # Match OpenClaw's unattended host exec policy using Hermes's own knob.
      approvals.mode = "off";
      model = {
        default = "gpt-6.1-sol";
        provider = "openai-codex";
      };
      # Keep this agent's subscriptions and refresh tokens independent.
      auth.adopt_external_logins = false;
      stt = {
        enabled = true;
        provider = "elevenlabs";
        elevenlabs.model = "scribe_v2";
      };
      tts = {
        provider = "elevenlabs";
        elevenlabs.model_id = "eleven_v4";
      };
      # In Telegram, /voice on selects voice-note replies. Do not turn on
      # auto_tts globally, which would speak ordinary text messages too.
      voice.auto_tts = false;
    };
    mcpServers = {
      home-assistant = {
        url = "http://homeassistant.${config.my.domain}:8123/api/mcp";
        headers.Authorization = "Bearer \${HOME_ASSISTANT_TOKEN}";
      };
      home-assistant-admin.url = "http://homeassistant.${config.my.domain}:9583/\${HOME_ASSISTANT_ADMIN_MCP_PATH}";
    };
    # Living documents belong to persistent agent state, outside the repo.
    # Leave SOUL.md, workspace AGENTS.md and learned memory unmanaged so
    # rebuilding the host never replaces the agent's edits.
  };

  environment.etc."hermes-agent/telegram.env.example".source = ./hermes-agent/telegram.env.example;
}
