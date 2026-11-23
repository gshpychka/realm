# DaVinci Resolve project database, shared by the Resolve installs on eve and
# reaper (Windows). In Resolve: Project Manager → Project Libraries → Add →
# Network, host hoard.local on the LAN or hoard's tailnet address elsewhere,
# user `resolve`, password from secrets/hoard/resolve.yaml.
# The role can create databases, so each project library is created from
# Resolve itself.
{
  config,
  lib,
  pkgs,
  utils,
  ...
}:
let
  role = "resolve";
  lanInterface = config.systemd.network.networks."10-primary".matchConfig.Name;
  # Tailscale assigns every tailnet address from this range
  tailnetCidr = "100.64.0.0/10";
  arrayMountPoint = config.fileSystems."/mnt/hoard".mountPoint;
  arrayMountUnit = "${utils.escapeSystemdPath arrayMountPoint}.mount";
  backupDir = "${arrayMountPoint}/backups/resolve-db";
  # number of backup runs kept; a run holds one dump per project library
  backupRetention = 10;
  postgresql = config.services.postgresql.package;
  psql = "${postgresql}/bin/psql";
  postgresUser = config.systemd.services.postgresql.serviceConfig.User;
in
{
  sops.secrets.resolve-db-password = {
    sopsFile = ../../secrets/hoard/resolve.yaml;
    key = "resolve-db-password";
    owner = postgresUser;
    restartUnits = [ config.systemd.services.resolve-db-password.name ];
  };

  services.postgresql = {
    enable = true;
    package = pkgs.postgresql_18;
    enableTCPIP = true;
    settings.port = 5432;
    authentication = ''
      host all ${role} ${config.my.lan.cidr} scram-sha-256
      host all ${role} ${tailnetCidr} scram-sha-256
    '';
    ensureUsers = [
      {
        name = role;
        ensureClauses = {
          login = true;
          createdb = true;
        };
      }
    ];
  };

  # opens the port on the LAN and tailnet interfaces
  networking.firewall.interfaces =
    lib.genAttrs
      [
        lanInterface
        config.services.tailscale.interfaceName
      ]
      (_: {
        allowedTCPPorts = [ config.services.postgresql.settings.port ];
      });

  systemd.services.resolve-db-password = {
    description = "Set the password of the Resolve database role";
    requires = [ "postgresql-setup.service" ];
    after = [ "postgresql-setup.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = postgresUser;
    };
    # psql's backtick \set reads the secret, keeping it out of the process arguments
    script = ''
      ${psql} --set ON_ERROR_STOP=1 <<'EOF'
      \set password `cat ${config.sops.secrets.resolve-db-password.path}`
      ALTER ROLE ${role} PASSWORD :'password';
      EOF
    '';
  };

  # Dumps every project library to plain SQL on the SSD and compares the digest
  # of the dumps with the last stored run. A changed digest stores the
  # compressed dumps on the array as a new run.
  systemd.services.resolve-db-backup = {
    description = "Dump the Resolve project libraries after changes";
    requires = [ "postgresql.service" ];
    after = [
      "postgresql.service"
      arrayMountUnit
    ];
    unitConfig = {
      ConditionPathIsMountPoint = arrayMountPoint;
      RequiresMountsFor = backupDir;
    };
    onFailure = [ "notify-unit-failure@%n.service" ];
    path = [
      postgresql
      pkgs.coreutils
      pkgs.findutils
      pkgs.zstd
    ];
    serviceConfig = {
      Type = "oneshot";
      User = postgresUser;
      StateDirectory = "resolve-db-backup";
    };
    script = ''
      set -euo pipefail
      # reads one database name per line, keeping names with spaces whole
      mapfile -t databases < <(psql --tuples-only --no-align --command \
        "SELECT datname FROM pg_database WHERE datdba = '${role}'::regrole")
      [ "''${#databases[@]}" -gt 0 ] || exit 0

      staging="$STATE_DIRECTORY/staging"
      digest_file="$STATE_DIRECTORY/digest"
      rm --recursive --force "$staging"
      mkdir "$staging"
      for db in "''${databases[@]}"; do
        # a fixed \restrict key keeps identical data producing identical dumps
        pg_dump --format=plain --restrict-key=${role} --file="$staging/$db.sql" "$db"
      done
      # the digest covers every dump's name and contents
      digest=$(cd "$staging" && sha256sum -- *.sql | sha256sum)
      if [ "$digest" = "$(cat "$digest_file" 2>/dev/null || true)" ]; then
        rm --recursive "$staging"
        exit 0
      fi

      run_dir="${backupDir}/$(date --utc +%Y%m%dT%H%M%SZ)"
      mkdir "$run_dir"
      for dump in "$staging"/*.sql; do
        zstd --quiet "$dump" -o "$run_dir/$(basename "$dump").zst"
      done
      printf '%s' "$digest" > "$digest_file"
      rm --recursive "$staging"

      find "${backupDir}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
        | sort | head --lines=-${toString backupRetention} \
        | xargs --no-run-if-empty -I{} rm --recursive "${backupDir}/{}"
    '';
  };

  # Creates the postgres-owned backup directory on the array and grants postgres
  # traversal of the array root through an ACL, whenever the array is mounted at
  # activation. Both persist on the array across boots.
  system.activationScripts.resolve-db-backup-dir = {
    # the postgres user exists once the users snippet has run
    deps = [ "users" ];
    text = ''
      if ${pkgs.util-linux}/bin/mountpoint --quiet ${arrayMountPoint}; then
        ${pkgs.acl}/bin/setfacl --modify user:${postgresUser}:x ${arrayMountPoint}
        ${pkgs.coreutils}/bin/install --directory \
          --owner=${postgresUser} \
          --mode=0700 ${backupDir}
      fi
    '';
  };

  systemd.timers.resolve-db-backup = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      Persistent = true;
      Unit = config.systemd.services.resolve-db-backup.name;
    };
  };
}
