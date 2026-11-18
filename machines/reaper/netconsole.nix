# Streams the kernel log to the netconsole receiver over UDP. The kernel sends it
# straight from the network driver, so messages still go out when the root disk
# has dropped off the bus and nothing can be written to the local journal.
#
# On the receiver:
#   journalctl -t reaper
{
  config,
  pkgs,
  ...
}:
let
  receiverName = config.my.netconsole.host;
  receiverIp = config.my.hosts.${receiverName}.lanIp;
  localIp = config.my.hosts.${config.networking.hostName}.lanIp;
  interface = config.networking.interfaces.eno3.name;
  target = "/sys/kernel/config/netconsole/${receiverName}";
in
{
  boot.kernelModules = [ "netconsole" ];

  systemd.services.netconsole = {
    description = "Kernel log to ${receiverName} over netconsole";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];
    path = [
      pkgs.iproute2
      pkgs.jq
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      # start once the receiver answers; the ping also resolves its MAC over ARP
      ExecCondition = "${pkgs.iputils}/bin/ping -q -c 1 -W 2 ${receiverIp}";
    };
    script = ''
      # netconsole builds Ethernet frames itself and needs the receiver's MAC
      mac=$(ip -j neigh show ${receiverIp} dev ${interface} | jq -er '.[0].lladdr')

      # a target only accepts settings while disabled, and rejects disabling
      # when it is already off
      mkdir -p ${target}
      if [ "$(cat ${target}/enabled)" = 1 ]; then
        echo 0 > ${target}/enabled
      fi
      echo ${interface} > ${target}/dev_name
      echo ${localIp} > ${target}/local_ip
      echo ${receiverIp} > ${target}/remote_ip
      echo ${toString config.my.netconsole.port} > ${target}/remote_port
      echo "$mac" > ${target}/remote_mac
      echo 1 > ${target}/enabled

      # netconsole receives only messages below the console log level. Level 7
      # passes everything except debug, to the local console as well.
      echo 7 > /proc/sys/kernel/printk
    '';
    preStop = ''
      if [ "$(cat ${target}/enabled)" = 1 ]; then
        echo 0 > ${target}/enabled
      fi
    '';
  };

  # retries netconsole while the receiver doesn't answer
  systemd.timers.netconsole = {
    wantedBy = [ "timers.target" ];
    timerConfig.OnUnitInactiveSec = "10s";
  };
}
