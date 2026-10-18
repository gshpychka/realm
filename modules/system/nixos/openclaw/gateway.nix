# The OpenClaw gateway (https://docs.openclaw.ai): the agent's service on this
# host, its workspace, and its openclaw.json, validated at build time.
{
  config,
  lib,
  pkgs,
  inputs,
  ...
}:
let
  cfg = config.my.openclaw;
  gw = config.services.openclaw-gateway;

  # environment.etc keys are relative to /etc
  configEtcPath = lib.removePrefix "/etc/" gw.configPath;
  # the rendered openclaw.json
  configFile = config.environment.etc.${configEtcPath}.source;

  # the gateway refuses to start on a config that fails this validation
  configCheck =
    pkgs.runCommand "openclaw-config-check"
      {
        env =
          gw.environment
          # each secret's variable, so that its ${VAR} references resolve
          // lib.mapAttrs (_: _: "1") cfg.secrets
          // {
            OPENCLAW_CONFIG_PATH = configFile;
          };
      }
      ''
        # a writable home and state directory for the CLI, inside the build's scratch directory
        export HOME=$TMPDIR OPENCLAW_STATE_DIR=$TMPDIR/state
        # the gateway's own validation, as JSON (--json), shown in the build log and kept as the check's output (tee $out)
        ${lib.getExe gw.package} config validate --json | tee $out
        # fails the build (-e) on any warning, such as an unresolved ''${VAR} reference
        ${lib.getExe pkgs.jq} -e '.warnings == []' $out
      '';

  # The unit's ExecStartPost: its start, and with it the switch that started
  # it (switch-to-configuration exits 4 on a failed start job), succeeds once
  # the gateway is ready and accepts its own credentials, within TimeoutStartSec.
  readinessCheck = pkgs.writeShellApplication {
    name = "openclaw-gateway-readiness";
    runtimeInputs = [ pkgs.curl ];
    text = ''
      # /readyz answers 200 once startup, the state and agent databases, plugins and channels are ready; it takes no credentials
      until curl --silent --fail --output /dev/null ${cfg.localUrl}/readyz; do
        sleep 1
      done
      # a health call over the gateway's WebSocket, authenticated with the gateway secret in the unit's environment; exits 1 when the gateway rejects it
      ${lib.getExe gw.package} gateway health
    '';
  };
in
{
  imports = [ inputs.nix-openclaw.nixosModules.openclaw-gateway ];

  options.my.openclaw = {
    enable = lib.mkEnableOption "the OpenClaw gateway";

    pluginPaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Native plugin paths, merged before rendering the Gateway JSON config.";
    };

    bindings = lib.mkOption {
      type = lib.types.listOf (lib.types.attrsOf lib.types.json);
      default = [ ];
      example = [
        {
          agentId = "main";
          match = {
            channel = "telegram";
            accountId = "*";
          };
        }
      ];
      description = "Route bindings (https://docs.openclaw.ai/concepts/multi-agent), merged before rendering the Gateway JSON config; empty leaves `bindings` unset.";
    };

    workspace = lib.mkOption {
      type = lib.types.str;
      default = "${gw.stateDir}/workspace";
      readOnly = true;
      description = "The agent's workspace (https://docs.openclaw.ai/concepts/agent-workspace).";
    };

    mainSessionKey = lib.mkOption {
      type = lib.types.str;
      # the default agent, main, under the default DM scope
      default = "agent:main:main";
      readOnly = true;
      description = "Key of the agent's main session, which its direct messages share (https://docs.openclaw.ai/concepts/main-session).";
    };
  };

  config = lib.mkIf cfg.enable {
    services.openclaw-gateway = {
      enable = true;
      package = pkgs.openclaw;
      # Nix mode (https://docs.openclaw.ai/install/nix): Nix owns openclaw.json and the installed package
      environment.OPENCLAW_NIX_MODE = "1";
      config = {
        # the gateway starts only in local mode
        gateway.mode = "local";
        agents.defaults = {
          inherit (cfg) workspace;
          userTimezone = config.time.timeZone;
          # no recurring heartbeat turns (https://docs.openclaw.ai/gateway/heartbeat)
          heartbeat.every = "0m";
        };
        browser.enabled = false;
        # The upstream JSON option uses recursiveUpdate, which replaces lists.
        # Aggregate in a typed Nix list first so one plugin cannot erase another.
        plugins.load.paths = cfg.pluginPaths;
      }
      // lib.optionalAttrs (cfg.bindings != [ ]) {
        # the same for bindings, a list too
        inherit (cfg) bindings;
      };
    };

    environment.etc.${configEtcPath} = {
      # mkForce: OpenClaw's security audit rates a config others can read as critical
      mode = lib.mkForce "0400";
      inherit (gw) user;
    };

    systemd.services.${gw.unitName} = {
      # the config file sits in /etc, outside the unit definition systemd compares
      restartTriggers = [ configFile ];
      serviceConfig = {
        # mkForce: the module's logPath default is a file nothing rotates
        StandardOutput = lib.mkForce "journal";
        StandardError = lib.mkForce "journal";
        UMask = "0077";

        ExecStartPost = [ (lib.getExe readinessCheck) ];
        # the gateway is ready about 10s after its start in tests/nixos-switch.nix
        TimeoutStartSec = 120;
        # On stop, SIGTERM reaches the gateway alone, which drains active
        # turns before it exits 0; the SIGKILL that follows reaches what its
        # turns leave behind. The gateway sizes its drain from TimeoutStopUSec.
        # Both are the values the systemd unit OpenClaw installs itself uses.
        KillMode = "mixed";
        TimeoutStopSec = 330;
      };
    };

    # OpenClaw runs ffmpeg and ffprobe only from fixed system directories, /run/current-system/sw/bin among them
    environment.systemPackages = [ pkgs.ffmpeg-headless ];

    system.checks = [ configCheck ];
  };
}
