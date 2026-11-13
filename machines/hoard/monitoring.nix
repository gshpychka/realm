{
  config,
  ...
}:
let
  inherit ((import ./ports.nix { inherit config; })) ports;
in
{
  services = {
    homepage-dashboard = {
      enable = true;
      settings = {
        title = config.networking.hostName;
      };
      allowedHosts = config.services.nginx.virtualHosts.home.serverName;
      environmentFiles = [ config.sops.templates."homepage-dashboard.env".path ];
      services = [
        {
          "Streaming" = [
            {
              "Plex" = {
                icon = "plex";
                href = "https://app.plex.tv";
                widgets = [
                  {
                    type = "plex";
                    url = "http://127.0.0.1:${toString ports.plex}";
                    key = "{{HOMEPAGE_VAR_PLEX_TOKEN}}";
                  }
                ];
              };
            }
          ];
        }
        {
          "Downloaders" = [
            {
              "qBittorrent" = {
                icon = "qbittorrent";
                href = "https://${config.services.nginx.virtualHosts.qbittorrent.serverName}";
                widgets = [
                  {
                    type = "qbittorrent";
                    url = "http://127.0.0.1:${toString ports.qbittorrent}";
                    username = "{{HOMEPAGE_VAR_QBITTORRENT_USERNAME}}";
                    password = "{{HOMEPAGE_VAR_QBITTORRENT_PASSWORD}}";
                  }
                ];
              };
            }
            {
              "sabnzbd" = {
                icon = "sabnzbd";
                href = "https://${config.services.nginx.virtualHosts.sabnzbd.serverName}";
                widgets = [
                  {
                    type = "sabnzbd";
                    url = "http://127.0.0.1:${toString ports.sabnzbd}";
                    key = "{{HOMEPAGE_VAR_SABNZBD_API_KEY}}";
                  }
                ];
              };
            }
          ];
        }
        {
          "Arr stack" = [
            {
              "Sonarr" = {
                icon = "sonarr";
                href = "https://${config.services.nginx.virtualHosts.sonarr.serverName}";
                widgets = [
                  {
                    type = "sonarr";
                    url = "http://127.0.0.1:${toString ports.sonarr}";
                    key = "{{HOMEPAGE_VAR_SONARR_API_KEY}}";
                  }
                ];
              };
            }
            {
              "Radarr" = {
                icon = "radarr";
                href = "https://${config.services.nginx.virtualHosts.radarr.serverName}";
                widgets = [
                  {
                    type = "radarr";
                    url = "http://127.0.0.1:${toString ports.radarr}";
                    key = "{{HOMEPAGE_VAR_RADARR_API_KEY}}";
                  }
                ];
              };
            }
            {
              "Lidarr" = {
                icon = "lidarr";
                href = "https://${config.services.nginx.virtualHosts.lidarr.serverName}";
                widgets = [
                  {
                    type = "lidarr";
                    url = "http://127.0.0.1:${toString ports.lidarr}";
                    key = "{{HOMEPAGE_VAR_LIDARR_API_KEY}}";
                  }
                ];
              };
            }
            {
              "Prowlarr" = {
                icon = "prowlarr";
                href = "https://${config.services.nginx.virtualHosts.prowlarr.serverName}";
                widgets = [
                  {
                    type = "prowlarr";
                    url = "http://127.0.0.1:${toString ports.prowlarr}";
                    key = "{{HOMEPAGE_VAR_PROWLARR_API_KEY}}";
                  }
                ];
              };
            }
          ];
        }
      ];
    };
  };

  sops = {
    secrets = {
      qbittorrent-username = { };
      qbittorrent-password = { };
      sabnzbd-api-key = { };
      plex-token = { };
    };
    templates = {
      "homepage-dashboard.env" = {
        content = ''
          HOMEPAGE_VAR_RADARR_API_KEY=${config.sops.placeholder.radarr-api-key}
          HOMEPAGE_VAR_SONARR_API_KEY=${config.sops.placeholder.sonarr-api-key}
          HOMEPAGE_VAR_LIDARR_API_KEY=${config.sops.placeholder.lidarr-api-key}
          HOMEPAGE_VAR_PROWLARR_API_KEY=${config.sops.placeholder.prowlarr-api-key}
          HOMEPAGE_VAR_QBITTORRENT_USERNAME=${config.sops.placeholder.qbittorrent-username}
          HOMEPAGE_VAR_QBITTORRENT_PASSWORD=${config.sops.placeholder.qbittorrent-password}
          HOMEPAGE_VAR_SABNZBD_API_KEY=${config.sops.placeholder.sabnzbd-api-key}
          HOMEPAGE_VAR_PLEX_TOKEN=${config.sops.placeholder.plex-token}
        '';
        restartUnits = [ config.systemd.services.homepage-dashboard.name ];
        mode = "0400";
      };
    };
  };
}
