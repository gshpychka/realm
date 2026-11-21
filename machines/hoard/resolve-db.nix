# DaVinci Resolve project database, shared by the Resolve installs on eve and
# reaper (Windows). In Resolve: Project Manager → Project Libraries → Add →
# Network, host hoard, user `resolve`, password from secrets/hoard/resolve.yaml.
# The role can create databases, so each project library is created from
# Resolve itself.
{
  config,
  pkgs,
  utils,
  ...
}:
let
  role = "resolve";
  lanInterface = config.systemd.network.networks."10-primary".matchConfig.Name;
  arrayMountPoint = config.fileSystems."/mnt/hoard".mountPoint;
  arrayMountUnit = "${utils.escapeSystemdPath arrayMountPoint}.mount";
  backupDir = "${arrayMountPoint}/backups/resolve-db";
  # number of backup runs kept; a run holds one dump per project library
  backupRetention = 10;
  postgresql = config.services.postgresql.package;
  psql = "${postgresql}/bin/psql";
in
{
  sops.secrets.resolve-db-password = {
    sopsFile = ../../secrets/hoard/resolve.yaml;
    key = "resolve-db-password";
    owner = config.systemd.services.postgresql.serviceConfig.User;
    restartUnits = [ config.systemd.services.resolve-db-password.name ];
  };

  services.postgresql = {
    enable = true;
    package = pkgs.postgresql_18;
    enableTCPIP = true;
    settings = {
      port = 5432;
      # pg_last_committed_xact() reports the latest write, which gates backups
      track_commit_timestamp = true;
    };
    authentication = ''
      host all ${role} ${config.my.lan.cidr} scram-sha-256
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

  # LAN interface only; the secondary WAN interface carries a public address
  networking.firewall.interfaces.${lanInterface}.allowedTCPPorts = [
    config.services.postgresql.settings.port
  ];

  systemd.services.resolve-db-password = {
    description = "Set the password of the Resolve database role";
    requires = [ "postgresql-setup.service" ];
    after = [ "postgresql-setup.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = config.systemd.services.postgresql.serviceConfig.User;
    };
    # psql's backtick \set reads the secret, keeping it out of the process arguments
    script = ''
      ${psql} --set ON_ERROR_STOP=1 <<'EOF'
      \set password `cat ${config.sops.secrets.resolve-db-password.path}`
      ALTER ROLE ${role} PASSWORD :'password';
      EOF
    '';
  };

  # Dumps every project library when anything was written since the previous
  # run; idle days produce no dump. Read-only sessions allocate no transaction
  # id, so they leave the commit timestamp unchanged.
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
    ];
    serviceConfig = {
      Type = "oneshot";
      User = config.systemd.services.postgresql.serviceConfig.User;
      StateDirectory = "resolve-db-backup";
    };
    script = ''
      set -euo pipefail
      stamp_file="$STATE_DIRECTORY/last-commit"
      # empty when nothing has been written since track_commit_timestamp was enabled
      last_commit=$(psql --tuples-only --no-align --command \
        'SELECT (pg_last_committed_xact()).timestamp')
      if [ -z "$last_commit" ] || [ "$last_commit" = "$(cat "$stamp_file" 2>/dev/null || true)" ]; then
        exit 0
      fi

      run_dir="${backupDir}/$(date --utc +%Y%m%dT%H%M%SZ)"
      mkdir --parents "$run_dir"
      databases=$(psql --tuples-only --no-align --command \
        "SELECT datname FROM pg_database WHERE datdba = '${role}'::regrole")
      for db in $databases; do
        pg_dump --format=custom --file="$run_dir/$db.dump" "$db"
      done
      printf '%s' "$last_commit" > "$stamp_file"

      find "${backupDir}" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
        | sort | head --lines=-${toString backupRetention} \
        | xargs --no-run-if-empty -I{} rm --recursive "${backupDir}/{}"
    '';
  };

  # Creates the postgres-owned backup directory on the array whenever the array
  # is mounted at activation. The directory persists on the array across boots.
  system.activationScripts.resolve-db-backup-dir = {
    # the postgres user exists once the users snippet has run
    deps = [ "users" ];
    text = ''
      if ${pkgs.util-linux}/bin/mountpoint --quiet ${arrayMountPoint}; then
        ${pkgs.coreutils}/bin/install --directory \
          --owner=${config.systemd.services.postgresql.serviceConfig.User} \
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
