# Imperative, per secret named below, with the YubiKey or the op age key:
#   sops set secrets/hoard/openclaw.yaml '["openai-api-key"]' '"<key>"'
#   sops set secrets/hoard/openclaw.yaml '["elevenlabs-api-key"]' '"<key>"'
#   sops set secrets/hoard/openclaw.yaml '["home-assistant-token"]' '"<long-lived token of a dedicated HA user>"'
#   sops set secrets/hoard/secrets.yaml '["home-assistant-admin-mcp-path"]' '"<private_... path from the ha-mcp app log>"'
{ config, ... }:
{
  assertions = [
    {
      assertion =
        let
          wg = config.my.webGateway;
        in
        !config.my.openclaw.trustedProxy.enable || (wg.enable && wg.sso.enable && wg.loopbackGate.enable);
      message = "my.openclaw.trustedProxy on hoard needs my.webGateway's loopback gate to keep other local users off the gateway port.";
    }
  ];

  my.openclaw = {
    enable = true;
    # Fixed controller through owner-authorized native tools, never arbitrary shell.
    nixosControl.enable = true;
    sopsFile = ../../secrets/hoard/openclaw.yaml;
    publicHost = config.services.nginx.virtualHosts.openclaw.serverName;
    trustedProxy = {
      inherit (config.my.webGateway.sso) enable;
      userHeader = config.my.webGateway.sso.identityHeader;
      users = [ config.my.user ];
    };
    telegram.enable = true;
    responsesEndpoint.enable = true;

    model = {
      primary = "openai/gpt-6.1-sol";
      # the owner's ChatGPT subscription; OpenClaw's runtime takes OPENAI_API_KEY without an auth order
      authOrder.openai = [ "openai:chatgpt" ];
    };
    secrets = {
      OPENAI_API_KEY = "openai-api-key";
      ELEVENLABS_API_KEY = "elevenlabs-api-key";
    };
    # memory embeddings bill the API key; model calls go to the ChatGPT sign-in
    memorySearch.apiKey = config.my.openclaw.secretRefs.OPENAI_API_KEY;
    # spoken replies to voice notes
    tts = {
      provider = "elevenlabs";
      auto = "inbound";
      providers.elevenlabs = {
        modelId = "eleven_v4";
        # Keep the existing voice identity and normal pacing; v4 has no speaker boost.
        voiceSettings = {
          stability = 0.5;
          similarityBoost = 0.75;
          style = 0;
          useSpeakerBoost = false;
          speed = 1.0;
        };
      };
    };
    transcription = [
      {
        provider = "elevenlabs";
        model = "scribe_v2";
      }
    ];

    # HA's MCP Server integration: the Assist API over the entities exposed
    # to it, as a dedicated HA user
    mcpServers.home-assistant = {
      settings = {
        url = "http://homeassistant.${config.my.domain}:8123/api/mcp";
        transport = "streamable-http";
        headers.Authorization = "Bearer ${config.my.openclaw.secretVars.HOME_ASSISTANT_TOKEN}";
      };
      secrets.HOME_ASSISTANT_TOKEN = "home-assistant-token";
    };
    # The ha-mcp app (https://homeassistant-ai.github.io/ha-mcp/), for HA
    # administration; its URL path is its only credential.
    mcpServers.home-assistant-admin = {
      settings = {
        url = "http://homeassistant.${config.my.domain}:9583/${config.my.openclaw.secretVars.HOME_ASSISTANT_ADMIN_MCP_PATH}";
        transport = "streamable-http";
      };
      hostSecrets.HOME_ASSISTANT_ADMIN_MCP_PATH = "home-assistant-admin-mcp-path";
    };

    github = "calcifer-claw";

    claudeCode.enable = true;
    codex.enable = true;
    codexMigration.enable = true;
    onedrive.enable = true;

    root = {
      publicKey = config.my.sshKeys.hoardTpm;
      agentSocket = config.my.tpmSshKey.socket;
    };
  };

  # Appended to the provider-facing realtime Talk prompt, including GPT-Live.
  services.openclaw-gateway.config.talk.realtime.instructions = ''
    Always pronounce Kyiv as Ukrainian Київ /ˈkɪjiu̯/, including when speaking
    English. Preserve the Ukrainian и vowel, ї glide and first-syllable stress.
  '';

  my.githubApps.calcifer-claw = {
    appId = 5273943;
    installationId = 170281690;
    botUserId = 340989200;
    sopsFile = ../../secrets/hoard/openclaw.yaml;
  };

  my.tpmSshKey = {
    enable = true;
    user = config.services.openclaw-gateway.user;
  };

  systemd.services.${config.services.openclaw-gateway.unitName}.serviceConfig = {
    # the gateway and the sessions it spawns stay within 6 of hoard's 15 GB
    MemoryMax = "6G";
    # a runaway command's processes stop well short of the host's limit
    TasksMax = 1024;
  };
}
