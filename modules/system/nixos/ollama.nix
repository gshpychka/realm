{
  lib,
  pkgs,
  config,
  ...
}:

let
  cfg = config.my.ollama;
in
{
  options.my.ollama = {
    enable = lib.mkEnableOption "Ollama server + model loader + nginx proxy";

    loadModels = lib.mkOption {
      default = [ ];
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption {
              type = lib.types.str;
              description = "Model identifier – e.g. \"llama3\" or \"phi3:mini\".";
            };
            loadIntoVram = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Keep the model resident with keep_alive = -1.";
            };
          };
        }
      );
      description = ''
        Models to download on every boot; those with
        `loadIntoVram = true` are additionally pre-loaded into VRAM/CPU-RAM.
      '';
    };
  };

  config = lib.mkIf cfg.enable {

    services.ollama = {
      enable = true;
      package = pkgs.stableCudaPkgs.ollama-cuda;
      loadModels = lib.mkBefore (map (m: m.name) cfg.loadModels);
    };

    services.nginx = {
      enable = true;
      recommendedProxySettings = lib.mkForce false; # Ollama chokes otherwise

      virtualHosts."default".locations.${cfg.proxyPath} = {
        proxyPass = "http://${config.services.ollama.host}:${toString config.services.ollama.port}/";
        proxyWebsockets = true;
      };
    };

    systemd.services.ollama-preload = lib.mkIf (lib.any (m: m.loadIntoVram) cfg.loadModels) {
      description = "Warm selected Ollama models into VRAM";

      # when ollama.service is stopped/restarted, also stop/restart this service
      partOf = [ "ollama.service" ];

      # when ollama.service starts, also start this service (does not dictate order)
      wantedBy = [ "ollama.service" ];

      # this is what controls the order
      after = [
        "ollama.service"
        "ollama-model-loader.service"
      ];

      serviceConfig = {
        Type = "oneshot";
        Restart = "on-failure";
        # time between restarts
        RestartSec = "2s";

        # up to 6 restarts in the first 30 seconds
        StartLimitBurst = 6;
        StartLimitIntervalSec = 30;

        ExecStart = pkgs.writeShellScript "ollama-preload" ''
          set -euo pipefail
          api="http://${config.services.ollama.host}:${toString config.services.ollama.port}/api/generate"
          ${lib.concatMapStringsSep "\n" (
            m:
            lib.optionalString m.loadIntoVram ''
              echo "Pre-loading ${m.name}"
              ${pkgs.curl}/bin/curl --silent --show-error \
                --header 'Content-Type: application/json' \
                --data '{"model":"${m.name}","keep_alive":-1}' \
                "$api" >/dev/null
            ''
          ) cfg.loadModels}
        '';
      };
    };
  };
}
