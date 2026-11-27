{
  config,
  pkgs,
  ...
}:
let
  inherit (import ./ports.nix { inherit config; }) ports;

  # plex.direct hostnames encode an IPv4 address with dashes
  plexDirectLanLabel = builtins.replaceStrings [ "." ] [ "-" ] config.my.hosts.hoard.lanIp;
in
{
  services = {
    plex = {
      enable = true;
      openFirewall = true;
      group = "media";
      # The FHS resolver follows the namespace's file through its host /etc mount.
      package = pkgs.plex.override {
        buildFHSEnv =
          args:
          pkgs.buildFHSEnv (
            args
            // {
              extraBuildCommands = (args.extraBuildCommands or "") + ''
                ln -s /.host-etc/netns/wan2/resolv.conf "$out/etc/resolv.conf"
              '';
            }
          );
      };
    };

    jellyfin = {
      enable = true;
      group = "media";
    };
  };

  systemd.services.plex = {
    path = [
      pkgs.curl
      pkgs.coreutils
      pkgs.xmlstarlet
    ];
    # Plex knows only its namespace address, so it publishes hoard's LAN address
    # for LAN clients and counts the LAN as local. Plex rewrites Preferences.xml
    # from memory while running, so the edit lands before start.
    preStart = ''
      prefs="${config.services.plex.dataDir}/Plex Media Server/Preferences.xml"
      # Absent until the server is claimed and holds a plex.direct certificate.
      uuid=$(xmlstarlet sel -t -v /Preferences/@CertificateUUID "$prefs") || exit 0
      xmlstarlet ed -L \
        -d /Preferences/@customConnections \
        -i /Preferences -t attr -n customConnections \
        -v "https://${plexDirectLanLabel}.$uuid.plex.direct:${toString ports.plex}" \
        -d /Preferences/@LanNetworksBandwidth \
        -i /Preferences -t attr -n LanNetworksBandwidth -v "${config.my.lan.cidr}" \
        "$prefs"
    '';
    # Activation ends when the API answers.
    postStart = ''
      for _ in $(seq 60); do
        curl -sf -o /dev/null http://127.0.0.1:${toString ports.plex}/identity && exit 0
        sleep 1
      done
      echo "plex did not answer on port ${toString ports.plex}"
      exit 1
    '';
  };
}
