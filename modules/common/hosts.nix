{ lib, config, ... }:
# Fleet registry: the single source of truth for the LAN layout and per-host
# SSH access data. Consumed by harbor's dnsmasq/DHCP setup
# (machines/harbor/networking.nix) and the SSH client config
# (modules/home-manager/ssh.nix).
{
  options.my = {
    lan = {
      cidr = lib.mkOption {
        type = lib.types.str;
        description = "LAN subnet in CIDR notation";
      };
      routerIp = lib.mkOption {
        type = lib.types.str;
        description = "LAN router/gateway address";
      };
    };
    hosts = lib.mkOption {
      description = "Known hosts: LAN addressing and SSH access data";
      default = { };
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            lanIp = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Static LAN address (null = dynamic or not on the LAN)";
            };
            tailscaleIp = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Tailnet address, per `tailscale ip -4` (null = not a tailnet node)";
            };
            mac = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "MAC address for the DHCP static lease (null = host assigns its own address)";
            };
            enableSubdomains = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Resolve wildcard *.<name>.<domain> to lanIp";
            };
            sshUser = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "SSH user (null = my.user via the catch-all local match block)";
            };
            sshSettings = lib.mkOption {
              type = lib.types.attrs;
              default = { };
              description = "Extra ssh_config keys merged into this host's Match block";
            };
            voiceArea = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Home Assistant area of this Voice PE (null = not a Voice PE)";
            };
            homeAssistantDeviceId = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                Device registry ID of this Voice PE's ESPHome device in Home Assistant,
                which the voice broker runs home requests as. The router integration
                registers a second device under the same MAC; that one is not it.
              '';
            };
            tailscalePort = lib.mkOption {
              type = lib.types.nullOr lib.types.port;
              default = null;
              description = "Fixed local UDP port for this host's Tailscale daemon (null = default, chosen dynamically)";
            };
          };
        }
      );
    };
  };

  config.my = {
    lan = {
      cidr = "192.168.1.0/24";
      routerIp = "192.168.1.1";
    };
    hosts = {
      # harbor is the DHCP server and assigns its own static address
      harbor = {
        lanIp = "192.168.1.2";
        tailscaleIp = "100.113.82.84";
        enableSubdomains = true;
        # harbor's main user is "pi"
        sshUser = "pi";
        tailscalePort = 41641;
      };
      hoard = {
        lanIp = "192.168.1.3";
        mac = "E8:FF:1E:D6:89:EB";
        enableSubdomains = true;
      };
      # Existing HA Pi5 wired adapter; reservation applies only when harbor is
      # separately deployed. Preserve HA's current address across the OS swap.
      homeassistant = {
        lanIp = "192.168.1.212";
        mac = "2C:CF:67:03:09:D1";
        sshUser = "root";
      };
      reaper = {
        lanIp = "192.168.1.4";
        tailscaleIp = "100.76.49.76";
        mac = "C8:7F:54:0B:FB:8C";
        enableSubdomains = true;
        tailscalePort = 41642;
      };
      switch-alpha = {
        lanIp = "192.168.1.5";
        mac = "98:BA:5F:46:87:00";
      };
      # ASUS ZenWiFi ET8 mesh nodes, named by MAC suffix like the ASUS UI
      zenwifi-cc10 = {
        lanIp = "192.168.1.6";
        mac = "04:42:1A:C8:CC:10";
      };
      zenwifi-e288 = {
        lanIp = "192.168.1.7";
        mac = "7C:10:C9:E7:E2:88";
      };
      air-conditioner = {
        lanIp = "192.168.1.51";
        mac = "08:BC:20:04:48:5A";
      };
      tv = {
        lanIp = "192.168.1.52";
        mac = "1C:AF:4A:0C:6E:76";
      };
      # Home Assistant Voice PEs. Device IDs read from Home Assistant's device
      # registry (config/device_registry/list) on 2026-10-16: the entry whose
      # config entry is esphome, not the asuswrt router tracker with the same MAC.
      kitchen-assistant = {
        lanIp = "192.168.1.53";
        mac = "20:F8:3B:09:E1:BB";
        voiceArea = "Kitchen";
        homeAssistantDeviceId = "70f12d431cf502faeefdc782b45c0719";
      };
      room-assistant = {
        lanIp = "192.168.1.54";
        mac = "20:F8:3B:09:14:CC";
        voiceArea = "Room";
        homeAssistantDeviceId = "9290a2568e3df21ba0fd2d663249c0ca";
      };

      # ssh-only entries (not on the LAN / no static lease)
      iso = {
        sshUser = "nixos";
      };
      kodi = {
        sshUser = "root";
        sshSettings = {
          ForwardAgent = false;
          SetEnv.TERM = "xterm-256color";
        };
      };
      # GL.iNet Mudi travel router. 192.168.8.1 is its own LAN address,
      # reachable off-site through the 192.168.8.0/24 subnet route it advertises.
      oasis = {
        lanIp = "192.168.8.1";
        sshUser = "root";
        sshSettings = {
          ForwardAgent = false;
          SetEnv.TERM = "xterm-256color";
        };
      };
    };
  };

  config.assertions =
    let
      hostsWithPort = lib.filterAttrs (_: h: h.tailscalePort != null) config.my.hosts;
      namesByPort = lib.groupBy (name: toString hostsWithPort.${name}.tailscalePort) (
        lib.attrNames hostsWithPort
      );
      duplicates = lib.filterAttrs (_: names: lib.length names > 1) namesByPort;
    in
    lib.mapAttrsToList (port: names: {
      assertion = false;
      message = "my.hosts.*.tailscalePort ${port} is used by multiple hosts: ${lib.concatStringsSep ", " names}";
    }) duplicates;
}
