{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  haPkgs = inputs.nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system};
in
{
  _module.args.haPkgs = haPkgs;
  _module.args.haPackages = haPkgs.callPackage ../../packages/home-assistant { };
  imports = [
    ./hardware.nix
    ./home-assistant.nix
    ./services.nix
  ];

  networking.hostName = "homeassistant";
  networking.domain = config.my.domain;
  time.timeZone = "Europe/Kyiv";
  networking.useNetworkd = true;
  networking.useDHCP = false;
  # The matching reservation is declared in the fleet registry for harbor.
  systemd.network.links."10-home-assistant-lan" = {
    matchConfig.MACAddress = config.my.hosts.homeassistant.mac;
    linkConfig = {
      Name = "end0";
      NamePolicy = "";
    };
  };
  systemd.network.networks."10-lan" = {
    matchConfig.MACAddress = config.my.hosts.homeassistant.mac;
    networkConfig = {
      DHCP = "yes";
      IPv6AcceptRA = true;
      MulticastDNS = true;
    };
    dhcpV4Config.ClientIdentifier = "mac";
    linkConfig.RequiredForOnline = "routable";
  };
  networking.wireless.enable = false;
  services.resolved.enable = true;
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [
      8123
      21064 # HomeKit bridge
      32100 # DLNA renderer event callbacks
    ];
    allowedUDPPorts = [
      1900
      5353
      5540
    ];
    trustedInterfaces = [ "tailscale0" ];
    # SSDP search replies arrive from UDP 1900 at a dynamically chosen client
    # port. Conntrack cannot associate those unicast replies with a multicast
    # destination. Accept that source port on the wired LAN for IPv4/IPv6.
    extraCommands = ''
      for iptables_tool in iptables ip6tables; do
        "$iptables_tool" -w -I nixos-fw -i end0 -p udp --sport 1900 -j nixos-fw-accept
      done
    '';
    extraStopCommands = ''
      for iptables_tool in iptables ip6tables; do
        "$iptables_tool" -w -D nixos-fw -i end0 -p udp --sport 1900 -j nixos-fw-accept 2>/dev/null || true
      done
    '';
  };
  services.avahi = {
    enable = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      userServices = true;
    };
  };
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };
  users.users.root.openssh.authorizedKeys.keys = lib.unique [
    config.my.sshKeys.main
    config.my.sshKeys.openclaw
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBJOrPEgiVddcT1t+mm+xsbDnfj+nl1PBQyxzk5rQjeqPG3nkgWp/l8pIYrZojckIIOHLNERy1zYLigKGYp5crcA= calcifer@hoard"
  ];
  environment.systemPackages = with pkgs; [
    openssh
    sqlite
    restic
    rclone
  ];
  nix.settings = {
    max-jobs = 1;
    cores = 1;
  };
  system.stateVersion = "26.05";
}
