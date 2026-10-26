# MCP servers (https://docs.openclaw.ai/tools/mcp) whose tools the agent gets.
{ config, lib, ... }:
let
  cfg = config.my.openclaw;
in
{
  options.my.openclaw.mcpServers = lib.mkOption {
    default = { };
    description = "MCP servers whose tools the agent gets, keyed by server name.";
    type = lib.types.attrsOf (
      lib.types.submodule {
        options = {
          settings = lib.mkOption {
            type = lib.types.attrsOf lib.types.json;
            description = "The server's mcp.servers entry.";
          };
          secrets = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            example = {
              HOME_ASSISTANT_TOKEN = "home-assistant-token";
            };
            description = "Environment variables for \${NAME} references in settings, each set from the named sopsFile key.";
          };
          hostSecrets = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
            example = {
              HOME_ASSISTANT_ADMIN_MCP_PATH = "home-assistant-admin-mcp-path";
            };
            description = "Environment variables for \${NAME} references in settings, each set from the named key of this host's default sops file.";
          };
        };
      }
    );
  };

  config = lib.mkIf cfg.enable {
    my.openclaw.secrets = lib.mkMerge (lib.mapAttrsToList (_: server: server.secrets) cfg.mcpServers);
    my.openclaw.hostSecrets = lib.mkMerge (
      lib.mapAttrsToList (_: server: server.hostSecrets) cfg.mcpServers
    );
    services.openclaw-gateway.config.mcp.servers = lib.mapAttrs (
      _: server: server.settings
    ) cfg.mcpServers;
  };
}
