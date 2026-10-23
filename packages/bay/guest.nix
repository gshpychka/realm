# The session image: the NixOS system inside every session's VM.
{
  lib,
  pkgs,
  modulesPath,
  bay,
  ...
}:
let
  user = "dev";
  home = "/home/${user}";
  work = "/work";
  bay-session = pkgs.writeShellApplication {
    name = "bay-session";
    runtimeInputs = with pkgs; [
      bay.guestTools
      coreutils
      git
      gnutar
      procps
      systemd
      tmux
      util-linux
    ];
    runtimeEnv = {
      BAY_GUEST = lib.getExe bay.guestTools;
      SESSION_USER = user;
      SESSION_HOME = home;
      WORK = work;
    };
    text = builtins.readFile ./bay-session.sh;
  };
in
{
  imports = [ "${modulesPath}/virtualisation/incus-virtual-machine.nix" ];

  system.stateVersion = "26.05";

  # sessions are reached through incus exec only
  services.openssh.enable = false;
  users.users.root.initialHashedPassword = "!";

  documentation.enable = false;
  documentation.nixos.enable = false;
  system.installer.channel.enable = false;
  installer.cloneConfig = false;

  users.users.${user} = {
    isNormalUser = true;
    inherit home;
  };
  systemd.tmpfiles.settings.bay.${work}.d = {
    inherit user;
    group = "users";
    mode = "0755";
  };

  environment.systemPackages = [
    bay.flare
    bay-session
    pkgs.git
  ];

  # the gateway as an MCP server, in the mcpServers format agents load from a file
  environment.etc."bay/mcp.json".source = (pkgs.formats.json { }).generate "mcp.json" {
    mcpServers.bay = {
      type = "stdio";
      command = lib.getExe bay.flare;
      args = [ "mcp" ];
    };
  };

  programs.tmux = {
    enable = true;
    extraConfig = ''
      set -g remain-on-exit on
      set -g monitor-bell off
      set -g bell-action any
      set -g silence-action any
      set-hook -g alert-bell 'run-shell -b "${lib.getExe bay.flare} notify blocked"'
      set-hook -g alert-silence 'run-shell -b "${lib.getExe bay.flare} notify idle"'
      # the operator's terminal sees only what tmux renders
      set -g allow-passthrough off
      set -g set-clipboard off
      # the server runs as root; panes the operator opens get the session user's login shell
      set -g default-command "${pkgs.util-linux}/bin/runuser -l ${user}"
    '';
  };

  # every clone of the warm base renders its own hostname from its instance name
  networking.hostName = "";
  virtualisation.lxc.templates.hostname = {
    enable = true;
    target = "/etc/hostname";
    template = pkgs.writeText "hostname.tpl" "{{ container.name }}\n";
    when = [
      "create"
      "copy"
    ];
  };

  networking = {
    useDHCP = false;
    dhcpcd.enable = false;
    useHostResolvConf = false;
  };
  systemd.network = {
    enable = true;
    networks."50-ethernet" = {
      matchConfig.Type = "ether";
      networkConfig.DHCP = "ipv4";
      # clones of the warm base share its machine ID, which the default DUID client identifier derives from
      dhcpV4Config.ClientIdentifier = "mac";
      linkConfig.RequiredForOnline = "routable";
    };
  };
}
