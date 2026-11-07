{
  config,
  pkgs,
  ...
}:
let
  ntfyTopic = "buoy-status";
  themePython = pkgs.python3.withPackages (p: [ p.pillow ]);
  # Cloudflare and browsers cache these stable asset paths for hours. Change
  # every asset URL together whenever the UI package, theme or icon changes.
  themeRevision = builtins.substring 0 12 (
    builtins.hashString "sha256" (
      builtins.concatStringsSep "\n" [
        pkgs.gatus.version
        (builtins.readFile ./gatus-gruvbox.css)
        (builtins.readFile ./gatus-brand.py)
        (builtins.hashFile "sha256" ./gatus-hoard.jpg)
      ]
    )
  );

  # Gatus's ntfy provider writes its own message text, so ntfy alerts override the custom
  # provider's request with a plain-text publish. [ALERT_TRIGGERED_OR_RESOLVED] is substituted
  # raw, so each alert encodes the copy for its own body.
  #
  # Gatus keys persisted alert state by type and description, so each alert of the pair
  # carries a distinct description.
  #
  # os.ExpandEnv runs over the whole config, so a literal "$" in a message must be
  # written as "$$".
  mkAlerts =
    { triggered, resolved }:
    [
      {
        type = "custom";
        description = "telegram";
        send-on-resolved = true;
        provider-override.placeholders.ALERT_TRIGGERED_OR_RESOLVED = {
          TRIGGERED = builtins.toJSON triggered;
          RESOLVED = builtins.toJSON resolved;
        };
      }
      {
        type = "custom";
        description = "ntfy";
        send-on-resolved = true;
        provider-override = {
          url = "http://${config.services.ntfy-sh.settings.listen-http}/${ntfyTopic}";
          headers = {
            Authorization = "Bearer \${NTFY_TOKEN}";
            Priority = "4";
          };
          body = "[ALERT_TRIGGERED_OR_RESOLVED]";
          placeholders.ALERT_TRIGGERED_OR_RESOLVED = {
            TRIGGERED = triggered;
            RESOLVED = resolved;
          };
        };
      }
    ];
in
{
  services.gatus = {
    enable = true;
    # Gatus embeds its static files into the binary. Brand those before Go
    # builds it, so favicon, installable app and chart colors work without a
    # second web server or browser-side patching.
    package = pkgs.gatus.overrideAttrs (old: {
      postPatch = (old.postPatch or "") + ''
        ${themePython}/bin/python3 ${./gatus-brand.py} web/static ${./gatus-hoard.jpg} ${themeRevision}
      '';
    });
    environmentFile = config.sops.secrets.gatus-env.path;
    settings = {
      ui = {
        title = "Hoard · Status";
        header = "Hoard";
        description = "Service availability and response times across the realm.";
        dashboard-heading = "Service status";
        dashboard-subheading = "Availability and response times across the realm.";
        logo = "/hoard.png?v=${themeRevision}";
        favicon = {
          default = "/favicon.ico?v=${themeRevision}";
          size16x16 = "/favicon-16x16.png?v=${themeRevision}";
          size32x32 = "/favicon-32x32.png?v=${themeRevision}";
        };
        dark-mode = true;
        custom-css = builtins.readFile ./gatus-gruvbox.css;
      };
      web.address = "127.0.0.1";
      storage = {
        type = "sqlite";
        path = "/var/lib/gatus/data.db";
        # 7 days at one result per 30 s, kept per endpoint (Gatus defaults to 100)
        maximum-number-of-results = 20160;
      };
      alerting.custom = {
        url = "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/sendMessage";
        method = "POST";
        headers."Content-Type" = "application/json";
        # message_thread_id is numeric; chat_id is quoted to accept numeric or @username ids.
        # text is unquoted because the placeholder expands to a toJSON-encoded string.
        body = ''{"chat_id":"''${TELEGRAM_CHAT_ID}","message_thread_id":''${TELEGRAM_TOPIC_ID},"text":[ALERT_TRIGGERED_OR_RESOLVED]}'';
        # Fallback copy for any alert that omits its own messages.
        placeholders.ALERT_TRIGGERED_OR_RESOLVED = {
          TRIGGERED = builtins.toJSON "⚠️ A monitored service is having problems.";
          RESOLVED = builtins.toJSON "✅ A monitored service has recovered.";
        };
      };
      endpoints = [
        {
          name = "Internet";
          url = "icmp://wan.${config.my.domain}";
          interval = "30s";
          ui.hide-hostname = true;
          conditions = [ "[CONNECTED] == true" ];
          # Gatus sends one echo request per check, and the wan record lags a WAN failover by up to
          # its 60 s TTL plus the 30 s DDNS update period; 6 checks (3 min) outlast that lag and
          # runs of dropped packets
          # https://github.com/TwiN/gatus/blob/v5.38.0/client/client.go#L376
          alerts = map (alert: alert // { failure-threshold = 6; }) (mkAlerts {
            triggered = "🔴 Інтернет зник.";
            resolved = "🟢 Інтернет знову є.";
          });
        }
        {
          name = "Seerr";
          url = "https://seerr.${config.my.domain}";
          interval = "30s";
          conditions = [
            "[STATUS] == 200"
            "[RESPONSE_TIME] < 10000"
          ];
          alerts = mkAlerts {
            triggered = "🔴 Seerr недоступний.";
            resolved = "🟢 Seerr знову доступний.";
          };
        }
        {
          name = "Plex";
          url = "http://\${PLEX_HOST}:\${PLEX_PORT}/web/index.html";
          interval = "30s";
          ui = {
            hide-hostname = true;
            hide-errors = true;
          };
          conditions = [
            "[STATUS] == 200"
            "[RESPONSE_TIME] < 10000"
          ];
          alerts = mkAlerts {
            triggered = "🔴 Plex недоступний.";
            resolved = "🟢 Plex знову доступний.";
          };
        }
      ];
    };
  };

  services.ntfy-sh.settings.auth-access = [
    "gatus:${ntfyTopic}:write-only"
    "reader:${ntfyTopic}:read-only"
  ];

  sops.secrets.gatus-env = {
    sopsFile = ../../secrets/buoy/gatus.env;
    format = "dotenv";
  };
  sops.templates."gatus-ntfy.env" = {
    content = "NTFY_TOKEN=${config.sops.placeholder.ntfy-gatus-token}";
    restartUnits = [ "gatus.service" ];
  };
  # systemd list options concatenate, so this adds to the module's environmentFile
  systemd.services.gatus.serviceConfig.EnvironmentFile = [
    config.sops.templates."gatus-ntfy.env".path
  ];
}
