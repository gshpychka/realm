{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  inherit (import ./ports.nix { inherit config; }) ports;
  listen = "127.0.0.1:${toString ports.seerr-mcp}";
  package = inputs.seerr-mcp.packages.${pkgs.stdenv.hostPlatform.system}.default;
  token = "seerr-mcp-token";
in
{
  my.hermes-agent.secrets.SEERR_MCP_TOKEN = token;

  services.hermes-agent.mcpServers.seerr = {
    url = "http://${listen}/mcp";
    headers.Authorization = "Bearer \${SEERR_MCP_TOKEN}";
    sampling.enabled = false;
  };

  # Rotate this secret when Seerr's API key changes in Settings → General.
  sops.secrets.seerr-api-key.sopsFile = config.my.hermes-agent.sopsFile;

  sops.templates."seerr-mcp.env" = {
    content = ''
      SEERR_API_KEY=${config.sops.placeholder.seerr-api-key}
      MCP_BEARER_TOKEN=${config.sops.placeholder."hermes-agent/${token}"}
    '';
    restartUnits = [ config.systemd.services.seerr-mcp.name ];
  };

  systemd.services.seerr-mcp = {
    description = "Seerr MCP server";
    wantedBy = [ "multi-user.target" ];
    after = [ "seerr.service" ];
    wants = [ "seerr.service" ];
    environment = {
      MCP_LISTEN = listen;
      SEERR_URL = "http://127.0.0.1:${toString config.services.seerr.port}";
    };
    serviceConfig = {
      ExecStart = lib.getExe package;
      EnvironmentFile = config.sops.templates."seerr-mcp.env".path;
      DynamicUser = true;
      NoNewPrivileges = true;
      PrivateTmp = true;
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  systemd.services.hermes-agent = {
    after = [ "seerr-mcp.service" ];
    wants = [ "seerr-mcp.service" ];
  };
}
