{
  config,
  ...
}:
let
  inherit (import ./ports.nix { inherit config; }) ports;

  # Same checks as buoy's Seerr endpoint, minus alerts.
  mkSeerrCheck = name: url: {
    inherit name url;
    interval = "30s";
    # client.timeout is left at Gatus's 10 s default
    conditions = [
      "[STATUS] == 200"
      "[RESPONSE_TIME] < 10000"
    ];
  };
in
{
  # Diagnostic Gatus comparing Seerr at its origin against the public Cloudflare Tunnel
  # route, measured from the same host so the latency difference isolates the tunnel/edge.
  # No alerts and no public route: the UI is loopback-only (8080, the module default, is
  # already taken on hoard) and the firewall stays closed (openFirewall defaults to false).
  # Each stored result keeps its errors, so failures can be inspected over SSH:
  #   ssh -L 18880:127.0.0.1:18880 hoard   # UI at http://127.0.0.1:18880
  #   journalctl -u gatus
  #   sudo sqlite3 /var/lib/gatus/data.db   # endpoint_results.errors
  services.gatus = {
    enable = true;
    settings = {
      web = {
        address = "127.0.0.1";
        port = 18880;
      };
      storage = {
        type = "sqlite";
        path = "/var/lib/gatus/data.db";
        # 7 days at one result per 30 s, kept per endpoint (Gatus defaults to 100)
        maximum-number-of-results = 20160;
      };
      endpoints = [
        (mkSeerrCheck "Seerr origin" "http://127.0.0.1:${toString ports.seerr}/login")
        (mkSeerrCheck "Seerr public" "https://seerr.${config.networking.domain}/login")
      ];
    };
  };
}
