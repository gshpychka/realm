{
  config,
  lib,
  ...
}:
let
  inherit ((import ./ports.nix { inherit config; })) ports;
in
{
  services.cloudflared = {
    enable = true;
    # sops exec-file --no-fifo secrets/common/cloudflare-cert.pem 'env TUNNEL_ORIGIN_CERT={} cloudflared tunnel create hoard-tunnel'
    tunnels.hoard-tunnel = {
      default = "http_status:404";
      credentialsFile = config.sops.secrets.cloudflare-tunnel.path;
      ingress = {
        # sops exec-file --no-fifo secrets/common/cloudflare-cert.pem 'env TUNNEL_ORIGIN_CERT={} cloudflared tunnel route dns hoard-tunnel <hostname>'
        "seerr.${config.networking.domain}" = "http://localhost:${toString ports.seerr}";
        "tautulli.${config.networking.domain}" = "http://localhost:${toString ports.tautulli}";
      };
    };
  };

  my.webGateway = {
    enable = true;
    services = {
      home.port = ports.home;
      glances.port = ports.glances;
      maintainerr.port = ports.maintainerr;
      qbittorrent.port = ports.qbittorrent;
      sabnzbd = {
        port = ports.sabnzbd;
        apiBypassPrefixes = [
          "/api"
          "/sabnzbd/api"
        ];
      };
      sonarr = {
        port = ports.sonarr;
        apiBypassPrefixes = [
          "/api"
          "/feed"
        ];
      };
      radarr = {
        port = ports.radarr;
        apiBypassPrefixes = [
          "/api"
          "/feed"
        ];
      };
      lidarr = {
        port = ports.lidarr;
        apiBypassPrefixes = [
          "/api"
          "/feed"
        ];
      };
      prowlarr = {
        port = ports.prowlarr;
        apiBypassPrefixes = [ "/api" ];
      };
      bazarr = {
        port = ports.bazarr;
        apiBypassPrefixes = [ "/api" ];
      };

      # multi-user identity lives in these apps (Plex accounts, Jellyfin
      # accounts, Tautulli's own login), and seerr/tautulli are also
      # reachable from the internet through the Cloudflare tunnel above
      seerr = {
        port = ports.seerr;
        auth = "native";
      };
      tautulli = {
        port = ports.tautulli;
        auth = "native";
      };
      jellyfin = {
        port = ports.jellyfin;
        auth = "native";
      };
      openclaw = {
        port = ports.openclaw;
        websockets = true;
        loopbackClients = [
          config.services.openclaw-gateway.user
          config.users.users.voice-broker.name
        ];
      };
    }
    //
      lib.optionalAttrs
        (
          config.my.hermes-agent.enable
          && config.my.hermes-agent.dashboard.enable
          && config.my.hermes-agent.dashboard.publicHost != null
        )
        {
          hermes = {
            port = ports.hermes;
            auth = "native";
            websockets = true;
          };
        };
    loopbackGate.clients = [
      config.services.sonarr.user
      config.services.radarr.user
      config.services.lidarr.user
      config.services.bazarr.user
      config.services.recyclarr.user
      config.users.users.maintainerr.name
    ];
    sso = {
      enable = false;
      sopsFile = ../../secrets/hoard/authelia.yaml;
      users.${config.my.user} = {
        displayName = "Glib";
        email = "me@${config.my.domain}";
      };
    };
  };

  sops.secrets = {
    cloudflare-tunnel = {
      sopsFile = ../../secrets/hoard/cloudflare-tunnel.json;
      mode = "0440";
      format = "json";
      key = ""; # we want the entire file
    };
  };
}
