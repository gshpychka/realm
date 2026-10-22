# Bay: disposable VM sessions for coding agents; see packages/bay/docs/design.md.
#
# Alerts to ntfy on buoy need a publisher token, not set up yet:
#   ntfy token generate                                    # tk_..., on any machine with ntfy-sh
#   on buoy (machines/buoy/ntfy.nix): add a bay user and that token to the NTFY_AUTH_USERS/NTFY_AUTH_TOKENS lines,
#     plus "bay:bay:write-only" and "reader:bay:read-only" to auth-access
#   sops secrets/reaper/bay.yaml: ntfy-token: tk_...
# then uncomment services.bay.notifications below.
{
  config,
  lib,
  ...
}:
let
  cfg = config.my.bay;
  claude = [
    "claude"
    "--mcp-config"
    "/etc/bay/mcp.json"
  ];
  notify = event: {
    type = "command";
    command = "flare notify ${event}";
    async = true;
  };
in
{
  options.my.bay = {
    enable = lib.mkEnableOption "Bay";
  };

  config = lib.mkIf cfg.enable {
    # ZFS holds Bay's session pool and needs a host ID; reaper boots from ext4, so there is no root pool to import
    networking.hostId = "91e0f444";
    boot.zfs.forceImportRoot = false;

    # sops.secrets."bay/ntfy-token" = {
    #   sopsFile = ../../secrets/reaper/bay.yaml;
    #   key = "ntfy-token";
    # };

    services.bay = {
      enable = true;
      operator = config.my.user;
      network.address = "10.80.0.1/24";

      # notifications = {
      #   url = "https://ntfy.${config.my.domain}";
      #   tokenFile = config.sops.secrets."bay/ntfy-token".path;
      # };

      programs.claude = {
        command = claude;
        # `claude --continue` exits when the restored history holds no conversation yet
        resume = [
          "sh"
          "-c"
          ''"$@" --continue || exec "$@"''
          "claude"
        ]
        ++ claude;
        # .claude.json and .claude/.credentials.json hold the sign-in and stay out of history
        history = [
          ".claude/projects"
          ".claude/file-history"
          ".claude/tasks"
          ".claude/plans"
          ".claude/history.jsonl"
          ".claude/paste-cache"
        ];
        # Claude Code alerts through the hooks below
        monitor = false;
      };

      guest.modules = [
        (
          { pkgs, ... }:
          {
            environment.systemPackages = [ pkgs.claude-code ];
            environment.etc."claude-code/managed-settings.json".text = builtins.toJSON {
              # Claude Code deletes history by file time after cleanupPeriodDays, and restored history keeps its times
              cleanupPeriodDays = 36500;
              env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1";
              hooks = {
                Stop = [ { hooks = [ (notify "done") ]; } ];
                Notification = [
                  {
                    matcher = "permission_prompt|elicitation_dialog";
                    hooks = [ (notify "blocked") ];
                  }
                  {
                    matcher = "idle_prompt";
                    hooks = [ (notify "idle") ];
                  }
                ];
              };
            };
          }
        )
      ];
    };
  };
}
