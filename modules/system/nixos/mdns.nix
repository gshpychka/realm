# LAN hosts resolve .local names and publish their own address as
# <hostName>.local over multicast DNS.
{ config, lib, ... }:
{
  config = lib.mkIf ((config.my.hosts.${config.networking.hostName}.lanIp or null) != null) {
    services.avahi = {
      enable = true;
      nssmdns4 = true;
      settings.publish = {
        disable-publishing = false;
        publish-addresses = true;
        # AAAA records follow the host's IPv6 setting
        publish-aaaa-on-ipv4 = config.networking.enableIPv6;
      };
    };

    # avahi owns the mDNS port
    services.resolved.settings.Resolve.MulticastDNS = lib.mkIf config.services.resolved.enable false;
  };
}
