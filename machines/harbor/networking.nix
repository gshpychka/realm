{
  config,
  lib,
  ...
}:

let
  lanInterface = "eth0";
  routerAddress = config.my.lan.routerIp;
  machineAddress = config.my.hosts.${config.networking.hostName}.lanIp;

  # views over the fleet registry (modules/common/hosts.nix)
  lanHosts = lib.filterAttrs (_: h: h.lanIp != null) config.my.hosts;
  # hosts that get a DHCP static lease (we assign our own address ourselves)
  leaseHosts = lib.filterAttrs (_: h: h.mac != null) lanHosts;
  # hosts that need wildcard sub-domains (e.g. foo.reaper → reaper’s IP)
  subdomainHosts = lib.filterAttrs (_: h: h.enableSubdomains) lanHosts;
  # subset that is on the tailnet
  tailnetHosts = lib.filterAttrs (_: h: h.tailscaleIp != null) config.my.hosts;
  # every LAN host except ourselves (we are covered by expand-hosts)
  otherLanHosts = lib.filterAttrs (name: _: name != config.networking.hostName) lanHosts;
in
{
  networking = {
    interfaces."${lanInterface}" = {
      useDHCP = false; # we are the only DHCP server
      ipv4.addresses = [
        {
          address = machineAddress;
          prefixLength = 24;
        }
      ];
    };
    firewall = {
      logRefusedConnections = false;
    };
    defaultGateway = routerAddress;
    enableIPv6 = false;
    # Build /etc/hosts so expand‑hosts can append the domain and local look‑ups work offline.
    # Our own row (from the registry) overrides the default /etc/hosts entry that
    # would map our own domain to 127.0.0.2 - it sorts below it and takes precedence.
    hosts = lib.mapAttrs' (name: h: lib.nameValuePair h.lanIp [ name ]) lanHosts;

    firewall = {
      allowedTCPPorts = [
        53 # large DNS replies and DNSSEC
      ];
      allowedUDPPorts = [
        53 # normal DNS
        67 # DHCP server→client
      ];
    };
  };

  services.resolved.enable = lib.mkForce false; # disable systemd‑resolved stub

  services.adguardhome = {
    enable = true;
    mutableSettings = false;
    settings = {
      schema_version = 29;
      http.address = "127.0.0.1:3000"; # for the web UI
      users = [
        {
          name = "glib";
          password = "$2y$05$y0ENgc6LYa.yRCgtTG9eneZJTimtnlGV6AaIFNbp71byq/Qtn6Oru";
        }
      ];
      theme = "dark";
      auth_attempts = 5;
      block_auth_min = 15;
      dns = {
        bind_hosts = [
          "127.0.0.1" # the DNS server itself
        ];
        port = 5353; # does not clash with dnsmasq
        filtering_enabled = true;
        ratelimit = 100; # qps
        upstream_mode = "load_balance";
        upstream_dns = [
          # we can set the IPs directly and provide the hostname that will be used for TLS verification only
          "tls://1.1.1.1#cloudflare-dns.com"
          "tls://1.0.0.1#cloudflare-dns.com"
          "tls://8.8.8.8#dns.google"
          "tls://8.8.4.4#dns.google"
          "tls://9.9.9.9#dns.quad9.net"
          "tls://149.112.112.112#dns.quad9.net"
          "tls://dns.mullvad.net" # specifying the IP does not work (194.242.2.2)
        ];
        bootstrap_dns = [ ];
        allowed_clients = [
          # kind of redundant given our bind_hosts and firewall, but doesn't hurt
          "127.0.0.1/32"
        ];
        aaaa_disabled = true;
        upstream_timeout = "1s";
        use_http3_upstreams = true;
        enable_dnssec = true;
        cache_size = 1024 * 1024 * 50;
        blocked_response_ttl = 60 * 60 * 24;
        use_private_ptr_resolvers = false; # avoid a loop where AdGuard forwards PTR requests to dnsmasq

        # we don't want to use /etc/hosts, local domains should have been resolved by dnsmasq
        hostsfile_enabled = false;
      };
      filtering = {
        filtering_enabled = true;
        blocked_response_ttl = 60 * 60 * 24;
        safe_search = {
          enabled = false;
        };
      };
      filters = [
        {
          enabled = true;
          name = "AdGuard DNS filter";
          id = 1;
          url = "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt";
        }
      ];
      user_rules = map (d: "||${d}^") [
        "splashtop.com"
        "splashtop.eu"
        "splashtop.nr"
      ];
      clients = {
        # the only client is localhost anyway
        runtime_sources = {
          whois = false;
          arp = false;
          rdns = false;
          dhcp = false; # only works if adguard is the DHCP server
          hosts = true;
        };
      };
    };
  };
  services.dnsmasq = {
    enable = true;
    settings = {
      "listen-address" = [
        machineAddress
        "127.0.0.1"
      ];
      domain = config.networking.domain; # authoritative local domain
      "expand-hosts" = true; # add domain to /etc/hosts names (local domain can be omitted)
      "localise-queries" = true; # prefer same‑subnet answers (if multiple are available)
      "bogus-priv" = true; # drop RFC1918 reverse look‑ups that are not in DHCP leases
      "no-resolv" = true; # ignore /etc/resolv.conf
      "stop-dns-rebind" = true; # Reject addresses from upstream nameservers which are in the private IP ranges.
      "rebind-domain-ok" = "/plex.direct/"; # https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/

      # resolve these locally
      local =
        (map (name: "/" + name + "." + config.networking.domain + "/") (lib.attrNames otherLanHosts))
        ++ [
          # reverse zone kept local
          # Apple Bonjour service discovery queries
          # like `b._dns-sd._udp.125.113.150.10.in-addr.arpa`
          # are not caught by bogus-priv
          # so we handle them more explicitly
          # RFC 1918
          "/10.in-addr.arpa/"
          "/168.192.in-addr.arpa/"
          # technically covers more than what the RFC does, but yolo
          "/172.in-addr.arpa/"

          # suppress WPAD queries
          "/wpad.${config.networking.domain}/"
          "/wpad/"
        ];

      # wildcard A records for all our static hosts (ourselves included)
      # allows us to use subdomains
      # dnsmasq cannot alias wildcard to another name, so we have to specify the IPs
      # this is why we use static leases at all
      address =
        lib.mapAttrsToList (
          name: h: "/" + name + "." + config.networking.domain + "/" + h.lanIp
        ) subdomainHosts
        # wildcard A records resolving <name>-ts to the host's tailnet address
        ++ lib.mapAttrsToList (
          name: h: "/" + name + "-ts." + config.networking.domain + "/" + h.tailscaleIp
        ) tailnetHosts;

      # upstream
      server = [ "127.0.0.1#${toString config.services.adguardhome.settings.dns.port}" ];

      "dhcp-authoritative" = true; # tell clients we are the the only DHCP server
      "dhcp-range" = "192.168.1.100,192.168.1.254,24h";
      "dhcp-option" = [
        "option:router,${routerAddress}"
        "option:dns-server,${machineAddress}"
        "option:domain-search,${config.networking.domain}"
      ];
      # sticky leases
      "dhcp-host" = lib.mapAttrsToList (name: h: "${h.mac},${h.lanIp},${name}") leaseHosts;

    };
  };

  systemd.services.dnsmasq = {
    requires = [ config.systemd.services.adguardhome.name ]; # hard dependency
    after = [ config.systemd.services.adguardhome.name ]; # start order
    before = [ "nss-lookup.target" ]; # DNS must be ready before name resolution is considered available
    wantedBy = [ "nss-lookup.target" ];
    serviceConfig.Restart = "on-failure";
  };

  systemd.services.adguardhome = {
    before = [ "nss-lookup.target" ];
    wantedBy = [ "nss-lookup.target" ];
  };
}
