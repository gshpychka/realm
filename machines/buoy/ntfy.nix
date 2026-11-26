{
  config,
  lib,
  ...
}:
let
  notificationSenders = config.my.notifications.senders;
  notificationAccount = host: "notifications-${host}";
  notificationSecret = host: field: "${notificationAccount host}-${field}";
  forNotificationSenders = f: lib.concatMapStrings f notificationSenders;
in
{
  services.ntfy-sh = {
    enable = true;
    settings = {
      base-url = "https://ntfy.${config.my.domain}";
      listen-http = "127.0.0.1:2586";
      # cloudflared is the only ingress, so X-Forwarded-For carries the client address
      behind-proxy = true;
      auth-default-access = "deny-all";
      # ntfy.sh relays a content-free poll request to wake the iOS/Android apps
      upstream-base-url = "https://ntfy.sh";
      # Run once:
      #   keys=$(nix run nixpkgs#ntfy-sh -- webpush keys)
      #   printf '%s\n' "$keys" | sed -n 's/^web-push-private-key: /ntfy-web-push-private-key: /p' \
      #     | sops --encrypt --filename-override secrets/buoy/ntfy-web-push.yaml --input-type yaml --output-type yaml /dev/stdin \
      #     > secrets/buoy/ntfy-web-push.yaml
      #   printf '%s\n' "$keys" | sed -n 's/^web-push-public-key: //p'
      web-push-public-key = "BMOXVoata6kqPN5HlXwnrLLYIfD8Ljf02J3l81bxMyDpdNQ3xpfcqmeVcmR_wm7Rtshy9_pFGznSpKL3SLkRs98";
      web-push-file = "/var/lib/ntfy-sh/webpush.db";
      web-push-email-address = "ntfy@${config.my.domain}";
      auth-access = [
        "reader:${config.my.notifications.topic}:read-only"
      ]
      ++ map (
        host: "${notificationAccount host}:${config.my.notifications.topic}:write-only"
      ) notificationSenders;
    };
    # ntfy reconciles its auth DB against these lists on start and deletes unlisted entries
    environmentFile = config.sops.templates."ntfy.env".path;
  };

  # ntfy requires a bcrypt password per account; admin, gatus and the notification senders
  # authenticate with the tk_ tokens
  sops.secrets = {
    ntfy-admin-password-hash.sopsFile = ../../secrets/buoy/ntfy.yaml;
    ntfy-admin-token.sopsFile = ../../secrets/buoy/ntfy.yaml;
    ntfy-gatus-password-hash.sopsFile = ../../secrets/buoy/ntfy.yaml;
    ntfy-gatus-token.sopsFile = ../../secrets/buoy/ntfy.yaml;
    ntfy-reader-password-hash.sopsFile = ../../secrets/buoy/ntfy.yaml;
    ntfy-web-push-private-key.sopsFile = ../../secrets/buoy/ntfy-web-push.yaml;
  }
  // lib.listToAttrs (
    lib.concatMap (
      host:
      map
        (field: {
          name = notificationSecret host field;
          value = {
            sopsFile = ../../secrets/notifications/${host}.yaml;
            key = field;
          };
        })
        [
          "ntfy-password-hash"
          "ntfy-token"
        ]
    ) notificationSenders
  );

  sops.templates."ntfy.env" = {
    content =
      let
        secret = name: config.sops.placeholder.${name};
      in
      ''
        NTFY_AUTH_USERS=admin:${secret "ntfy-admin-password-hash"}:admin,gatus:${secret "ntfy-gatus-password-hash"}:user,reader:${secret "ntfy-reader-password-hash"}:user${
          forNotificationSenders (
            host: ",${notificationAccount host}:${secret (notificationSecret host "ntfy-password-hash")}:user"
          )
        }
        NTFY_AUTH_TOKENS=admin:${secret "ntfy-admin-token"},gatus:${secret "ntfy-gatus-token"}${
          forNotificationSenders (
            host: ",${notificationAccount host}:${secret (notificationSecret host "ntfy-token")}"
          )
        }
        NTFY_WEB_PUSH_PRIVATE_KEY=${secret "ntfy-web-push-private-key"}
      '';
    restartUnits = [ "ntfy-sh.service" ];
  };
}
