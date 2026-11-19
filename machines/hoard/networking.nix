{ config, ... }:
let
  inherit (import ./ports.nix { inherit config; }) ports;

  primaryLanInterface = "enp1s0";

  # A second uplink with its own routing table, used as the egress path for the
  # isolated namespace below.
  secondaryWan = {
    interface = "enp0s20f0u4";
    address = "109.86.45.81";
    gateway = "109.86.45.254";
    table = 100;
  };
in
{
  networking = {
    hostName = "hoard";
    usePredictableInterfaceNames = true;
    enableIPv6 = false;
    useNetworkd = true;
    useDHCP = false;
    firewall.logRefusedConnections = false;
  };

  services.avahi = {
    openFirewall = false;
    settings.server.allow-interfaces = [ primaryLanInterface ];
  };
  networking.firewall.interfaces.${primaryLanInterface}.allowedUDPPorts = [ 5353 ];

  systemd.network = {
    enable = true;

    config = {
      addRouteTablesToIPRoute2 = true;
      routeTables.secondary_wan = secondaryWan.table;
    };

    # Primary LAN interface
    networks."10-primary" = {
      matchConfig.Name = primaryLanInterface;
      networkConfig = {
        DHCP = "ipv4";
        IPv6AcceptRA = false;
      };
      # bare LAN host names resolve through the DHCP search domain
      dhcpV4Config.UseDomains = true;
    };

    links."10-primary" = {
      matchConfig.Name = primaryLanInterface;
      linkConfig.WakeOnLan = "magic";
    };

    # Secondary WAN interface
    networks."20-secondary-wan" = {
      matchConfig.Name = secondaryWan.interface;
      networkConfig = {
        Address = "${secondaryWan.address}/24";
        IPv6AcceptRA = false;
      };

      routes = [
        {
          Gateway = secondaryWan.gateway;
          Table = "secondary_wan";
        }
      ];

      routingPolicyRules = [
        {
          From = "${secondaryWan.address}/32";
          Table = "secondary_wan";
          Priority = 100;
        }
      ];
    };
  };

  # Run Plex in its own network namespace so its traffic egresses through the
  # secondary WAN. routingTable matches the secondary_wan table defined above.
  my.netns.wan2 = {
    hostAddress = "10.200.0.1";
    namespaceAddress = "10.200.0.2";
    # can't use harbor's own DNS server from here - use Google instead
    nameservers = [
      "1.1.1.1"
      "1.0.0.1"
    ];

    egress = {
      inherit (secondaryWan) interface;
      snatTo = secondaryWan.address;
      routingTable = secondaryWan.table;
      localNetworks = [ config.my.lan.cidr ];
    };

    portForwards = [
      {
        interface = primaryLanInterface;
        port = ports.plex;
      }
      {
        inherit (secondaryWan) interface;
        port = ports.plex;
      }
    ];

    boundServices = [ "plex" ];
  };
}
