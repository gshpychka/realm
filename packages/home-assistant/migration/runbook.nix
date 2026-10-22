{
  pkgs,
  lib,
  configuration,
}:
let
  preflight = pkgs.callPackage ./. { inherit configuration; };
  packages = pkgs.callPackage ../. { };
  componentDomains = pkgs.writeText "ha-component-domains.json" (
    builtins.toJSON (map (component: component.domain) packages.customComponents)
  );
in
pkgs.writeShellApplication {
  name = "home-assistant-migrate";
  runtimeInputs = with pkgs; [
    bash
    bluez
    coreutils
    curl
    dosfstools
    e2fsprogs
    findutils
    gawk
    git
    gnugrep
    gnused
    gnutar
    gzip
    jq
    iproute2
    mosquitto
    nix
    nixos-install-tools
    openssh
    parted
    podman
    python3
    rclone
    restic
    ripgrep
    rsync
    sqlite
    systemd
    tailscale
    util-linux
    yq-go
    zstd
  ];
  text = ''
    export HA_MIGRATION_SCRIPTS=${./.}
    export HA_MIGRATION_DECLARATIONS=${preflight.declarations}
    export HA_MIGRATION_PREFLIGHT=${lib.getExe preflight}
    export HA_MIGRATION_COMPONENTS=${componentDomains}
    exec bash ${./migrate.sh} "$@"
  '';
  meta.description = "Guarded ARM Home Assistant migration phases; complete procedure in the machine runbook";
}
