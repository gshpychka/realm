{ config, lib, ... }:
{
  services.avahi = lib.mkIf ((config.my.hosts.${config.networking.hostName}.lanIp or null) != null) {
    enable = true;
    nssmdns4 = true;
  };
}
