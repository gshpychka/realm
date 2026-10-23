# Declarative configuration for the Servarr stack.
#
# Each `my.arrSync.targets.<name>` describes config to push INTO one app (an *Arr or
# Prowlarr) over its REST API: root folders, download clients, notifications, import
# lists, metadata consumers, custom filters, settings singletons (config/naming,
# config/host, ...), quality definitions, fields of existing quality profiles and —
# for Prowlarr — applications. A per-target systemd oneshot runs the
# bundled `arr-sync` engine, which plans with reads only and then writes just what
# differs (see arr-sync.py for the matching and secret adoption rules).
#
# Auth uses the app's API key (X-Api-Key). The oneshot runs as root so it can read the
# SOPS secret files (root:root 0400) referenced by `apiKeyFile` / `secretFields`, and
# the app's database (read-only) to compare the secrets the API masks and the login.
#
# A target's `login` is the one thing written into the app's database instead, by
# `arr-login-<target>` before the app starts (see below); `journalctl -u 'arr-login-*'`
# shows "login matches its secret; nothing written" on every start of a set-up app.
#
# Before a deploy that changes this, check it against the live apps without writing:
#   sudo arr-sync-preview <target> --expect-no-changes
# (non-zero on a problem, a secret differing from SOPS, a held import list change, or
# with the flag any write).
# Verify after a deploy: journalctl -u 'arr-sync-*' shows "converged, 0 write(s)" on a
# second start; before-images of each run that wrote are in /var/lib/arr-sync (0700).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.arrSync;

  # ruff format owns line width and line breaks, so flake8's E501 and W503 are ignored.
  linted = pkgs.writers.writePython3Bin "arr-sync" {
    flakeIgnore = [
      "E501"
      "W503"
    ];
  } (builtins.readFile ./arr-sync.py);
  # the engine, usable only once its tests pass
  engine =
    pkgs.runCommand "arr-sync-tested"
      {
        nativeBuildInputs = [ pkgs.python3 ];
        meta.mainProgram = "arr-sync";
      }
      ''
        cp ${./arr-sync.py} arr_sync.py
        python3 -I ${./arr-sync-test.py} "$PWD"
        mkdir -p $out/bin
        ln -s ${lib.getExe linted} $out/bin/arr-sync
      '';

  json = (pkgs.formats.json { }).type;

  # Secret field values are runtime file paths (e.g. a SOPS secret), read by the engine
  # at activation. Stored as strings to keep the secret out of the Nix store.
  secretFieldsType = lib.types.attrsOf lib.types.str;

  idOption = lib.mkOption {
    type = lib.types.nullOr lib.types.ints.positive;
    default = null;
    description = ''
      The resource's id in the live app. It stays matched while it holds the same
      implementation, so a rename in the UI is undone instead of duplicated; a fresh
      install (other ids) falls back to matching by name.
    '';
  };

  # options shared by every provider kind
  providerOptions = {
    id = idOption;
    name = lib.mkOption {
      type = lib.types.str;
      description = "Display name; also the identity used when the id doesn't match.";
    };
    implementation = lib.mkOption {
      type = lib.types.str;
      example = "QBittorrent";
      description = "Implementation (must match a /schema entry).";
    };
    fields = lib.mkOption {
      type = lib.types.attrsOf json;
      default = { };
      description = "Non-secret implementation fields, e.g. host/port/category.";
    };
    secretFields = lib.mkOption {
      type = secretFieldsType;
      default = { };
      description = "Implementation fields whose values are read from a file at runtime.";
    };
  };

  downloadClientType = lib.types.submodule {
    options = providerOptions // {
      protocol = lib.mkOption {
        type = lib.types.enum [
          "torrent"
          "usenet"
        ];
      };
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
      };
      priority = lib.mkOption {
        type = lib.types.int;
        default = 1;
      };
      # null leaves the app's value alone (Prowlarr has no such settings)
      removeCompletedDownloads = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
      };
      removeFailedDownloads = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
      };
      tags = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.int);
        default = null;
      };
    };
  };

  notificationType = lib.types.submodule {
    options = providerOptions // {
      events = lib.mkOption {
        type = lib.types.attrsOf lib.types.bool;
        default = { };
        example = {
          onGrab = false;
          onUpgrade = true;
        };
        description = ''
          The notification's event flags (onGrab, onUpgrade, ...). Declare every flag of
          the implementation: an undeclared one is left as it is.
        '';
      };
      includeHealthWarnings = lib.mkOption {
        type = lib.types.bool;
        default = false;
      };
      tags = lib.mkOption {
        type = lib.types.listOf lib.types.int;
        default = [ ];
      };
    };
  };

  importListType = lib.types.submodule {
    options = providerOptions // {
      properties = lib.mkOption {
        type = lib.types.attrsOf json;
        default = { };
        example = {
          enabled = true;
          enableAuto = true;
          monitor = "movieOnly";
          rootFolderPath = "/mnt/movies";
        };
        description = ''
          Top-level settings of the list, which differ between apps (Radarr: enabled,
          enableAuto, monitor, searchOnAdd, minimumAvailability, rootFolderPath; Sonarr:
          enableAutomaticAdd, shouldMonitor, seriesType, ...). A key the app doesn't
          have is a problem that writes nothing. listType, listOrder and
          minRefreshInterval come from the implementation and aren't settable.
        '';
      };
      qualityProfile = lib.mkOption {
        type = lib.types.str;
        description = ''
          Name of the quality profile, resolved to this install's id. While it doesn't
          exist yet (Recyclarr creates it), the list is skipped.
        '';
      };
      tags = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = ''
          The list's tags, by label ([a-z0-9-]+), resolved to this install's ids; this is
          the whole set, so a tag added to the list in the UI is taken off it again. A
          missing tag is created; tags themselves are never renamed or deleted.
        '';
      };
    };
  };

  metadataType = lib.types.submodule {
    options = providerOptions // {
      enable = lib.mkOption { type = lib.types.bool; };
      tags = lib.mkOption {
        type = lib.types.listOf lib.types.int;
        default = [ ];
      };
    };
  };

  customFilterType = lib.types.submodule {
    options = {
      id = idOption;
      type = lib.mkOption {
        type = lib.types.str;
        example = "movieIndex";
        description = "The list the filter belongs to (movieIndex, queue, releases, ...).";
      };
      label = lib.mkOption {
        type = lib.types.str;
        description = "Display name; with the type, the identity used when the id doesn't match.";
      };
      filters = lib.mkOption {
        type = lib.types.listOf json;
        description = "The filter's conditions, as the API returns them.";
      };
    };
  };

  applicationType = lib.types.submodule {
    options = providerOptions // {
      syncLevel = lib.mkOption {
        type = lib.types.enum [
          "fullSync"
          "addOnly"
          "disabled"
        ];
        default = "fullSync";
      };
    };
  };

  # sizes in MB per minute; null is no limit
  qualityDefinitionType = lib.types.submodule {
    options = {
      title = lib.mkOption { type = lib.types.str; };
      minSize = lib.mkOption { type = lib.types.number; };
      preferredSize = lib.mkOption { type = lib.types.nullOr lib.types.number; };
      maxSize = lib.mkOption { type = lib.types.nullOr lib.types.number; };
    };
  };

  targetType = lib.types.submodule {
    options = {
      url = lib.mkOption {
        type = lib.types.str;
        example = "http://localhost:8989";
      };
      apiVersion = lib.mkOption {
        type = lib.types.enum [
          "v1"
          "v3"
        ];
        description = "API version: v3 for Sonarr/Radarr, v1 for Prowlarr/Lidarr.";
      };
      apiKeyFile = lib.mkOption {
        type = lib.types.str;
        description = "Path to a file holding the target's API key (sent as X-Api-Key).";
      };
      database = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          The app's SQLite database, opened read-only to compare secret fields the API
          masks. Without it a masked secret can't be checked and is left as it is.
        '';
      };
      login = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Path to a secret file holding the app's login as stored in its database (table
          Users): a JSON object with identifier, username, password (the base64 salted
          hash), salt and iterations. Requires `database`. Before every start of the app
          `arr-login-<target>` restores it into an app that has no login yet; every run
          compares it, and a differing login is never touched (the run fails).
        '';
      };
      afterUnits = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Extra systemd units to order after (e.g. download-client services).";
      };
      rootFolders = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
      };
      rootFolderNeedsProfiles = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Whether root folders require default quality/metadata profiles (Lidarr).
          When set, the engine attaches the first available profiles and monitor=all.
        '';
      };
      downloadClients = lib.mkOption {
        type = lib.types.listOf downloadClientType;
        default = [ ];
      };
      notifications = lib.mkOption {
        type = lib.types.listOf notificationType;
        default = [ ];
      };
      applications = lib.mkOption {
        type = lib.types.listOf applicationType;
        default = [ ];
      };
      importLists = lib.mkOption {
        type = lib.types.listOf importListType;
        default = [ ];
        description = ''
          Import lists. Saving an enabled list makes the app sync it at once (fetch,
          add, search), so arr-sync never writes one that ends up enabled: a missing
          list is created switched off, and a change to an enabled list is held and
          reported (the run fails) until it is made in the UI. Disabled lists are
          converged as usual.
        '';
      };
      metadata = lib.mkOption {
        type = lib.types.listOf metadataType;
        default = [ ];
        description = "Metadata consumers (Kodi, Plex, ...); the app seeds one per implementation.";
      };
      customFilters = lib.mkOption {
        type = lib.types.listOf customFilterType;
        default = [ ];
        description = "Saved filters of the UI's lists, stored server-side (/customfilter).";
      };
      settings = lib.mkOption {
        type = lib.types.attrsOf (lib.types.attrsOf json);
        default = { };
        example = {
          "config/naming".renameMovies = true;
        };
        description = ''
          Settings singletons keyed by their API path (GET returns one object with an
          id): only the listed keys are compared and written.
        '';
      };
      qualityDefinitions = lib.mkOption {
        type = lib.types.attrsOf qualityDefinitionType;
        default = { };
        description = "Quality sizes keyed by quality name; undeclared qualities are left alone.";
      };
      qualityProfiles = lib.mkOption {
        type = lib.types.attrsOf (lib.types.attrsOf json);
        default = { };
        description = ''
          Fields of existing quality profiles keyed by profile name. Profiles are never
          created here, so another owner (Recyclarr) keeps their qualities and scores.
        '';
      };
      waitForTargets = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Other target names whose API must be reachable before syncing (e.g. Prowlarr → *Arrs).";
      };
    };
  };

  # the engine's provider shape: top-level properties apart from fields
  provider =
    extraProperties: p:
    {
      inherit (p)
        name
        implementation
        fields
        secretFields
        ;
      properties = lib.filterAttrs (_: v: v != null) (extraProperties p);
    }
    // lib.optionalAttrs (p.id != null) { inherit (p) id; };

  specFile =
    tname: t:
    (pkgs.formats.json { }).generate "arr-sync-${tname}.json" {
      name = tname;
      inherit (t)
        url
        apiVersion
        apiKeyFile
        database
        login
        rootFolders
        rootFolderNeedsProfiles
        settings
        qualityDefinitions
        qualityProfiles
        ;
      downloadClients = map (provider (p: {
        inherit (p)
          enable
          priority
          protocol
          removeCompletedDownloads
          removeFailedDownloads
          tags
          ;
      })) t.downloadClients;
      notifications = map (provider (
        p:
        p.events
        // {
          inherit (p) includeHealthWarnings tags;
        }
      )) t.notifications;
      applications = map (provider (p: {
        inherit (p) syncLevel;
      })) t.applications;
      importLists = map (
        p:
        provider (p: p.properties) p
        // {
          inherit (p) qualityProfile;
          tagLabels = p.tags;
        }
      ) t.importLists;
      metadata = map (provider (p: {
        inherit (p) enable tags;
      })) t.metadata;
      customFilters = map (
        f: { inherit (f) type label filters; } // lib.optionalAttrs (f.id != null) { inherit (f) id; }
      ) t.customFilters;
      waitFor = map (n: {
        name = n;
        inherit (cfg.targets.${n}) url apiVersion apiKeyFile;
      }) t.waitForTargets;
    };

  backupDir = "/var/lib/arr-sync";

  preview = pkgs.writeShellApplication {
    name = "arr-sync-preview";
    text = ''
      # usage: arr-sync-preview <target> [--expect-no-changes]; GET requests only
      case "''${1:-}" in
      ${lib.concatStrings (
        lib.mapAttrsToList (tname: t: ''
          ${tname}) spec=${specFile tname t} ;;
        '') cfg.targets
      )}
      *) echo "usage: arr-sync-preview <${lib.concatStringsSep "|" (lib.attrNames cfg.targets)}> [--expect-no-changes]" >&2; exit 2 ;;
      esac
      shift
      exec ${lib.getExe engine} preview "$spec" "$@"
    '';
  };
in
{
  options.my.arrSync = {
    enable = lib.mkEnableOption "declarative Servarr configuration";
    targets = lib.mkOption {
      type = lib.types.attrsOf targetType;
      default = { };
      description = "Apps to push configuration into, keyed by their systemd service name.";
    };
  };

  config = lib.mkIf cfg.enable {
    system.build.arrSync = engine;
    environment.systemPackages = [ preview ];

    assertions = lib.mapAttrsToList (tname: t: {
      assertion = t.login == null || t.database != null;
      message = "my.arrSync.targets.${tname}.login needs the app's database";
    }) cfg.targets;

    # Restores a target's login into an app that has none (a fresh install), while the
    # app is stopped: wanted by and ordered before every start of it, and skipped while
    # it runs. No API can take the hash (see restore_login in arr-sync.py), so this is
    # the one write into the app's database: a single Users row, only into an empty
    # table, under an exclusive lock. On the very first start there is no database
    # yet; the app creates it without a login (arr-sync-<target> then fails, asking
    # for a restart), and the restart restores it. Imperative step on a fresh install:
    # `systemctl restart <app>` once after its first start, and don't fill in the
    # app's "authentication required" prompt before that: the login it creates would
    # be kept, and both units would fail until the secret matches it. Until the
    # restart the app runs with its default auth (none), as before arr-sync's first
    # write. A failure here never keeps the app from starting (it's only wanted).
    systemd.services =
      lib.mapAttrs' (
        tname: t:
        let
          app = config.systemd.services.${tname};
        in
        lib.nameValuePair "arr-login-${tname}" {
          description = "Restore ${tname}'s login from its secret";
          before = [ app.name ];
          wantedBy = [ app.name ];
          unitConfig.RequiresMountsFor = [ (dirOf t.database) ];
          serviceConfig = {
            Type = "oneshot";
            # oneshots wait forever by default; a hang must not hold the app's start
            TimeoutStartSec = 60;
            # exit 1 (skip) while the app runs; during the app's start job it's still inactive
            ExecCondition = "${pkgs.runtimeShell} -c '! ${lib.getExe' pkgs.systemd "systemctl"} is-active --quiet ${app.name}'";
            ExecStart = "${lib.getExe engine} restore-login ${t.database} %d/login";
            # as the app, so files SQLite creates beside the database stay the app's
            User = app.serviceConfig.User;
            Group = app.serviceConfig.Group;
            # the secret is root-only; systemd hands it over
            LoadCredential = "login:${t.login}";
            UMask = "0077";
            NoNewPrivileges = true;
            PrivateNetwork = true;
            PrivateTmp = true;
            ProtectHome = true;
            ProtectSystem = "strict";
            ReadWritePaths = [ (dirOf t.database) ];
          };
        }
      ) (lib.filterAttrs (_: t: t.login != null) cfg.targets)
      // lib.mapAttrs' (
        tname: t:
        let
          ownUnit = config.systemd.services.${tname}.name;
        in
        lib.nameValuePair "arr-sync-${tname}" {
          description = "Converge ${tname} configuration";
          after = [ ownUnit ] ++ t.afterUnits;
          # converges only while the app runs, and again each time it (re)starts:
          # partOf stops this with the app, so the app's next start runs it again
          wantedBy = [
            "multi-user.target"
            ownUnit
          ];
          partOf = [ ownUnit ];
          # Spec/engine live in the store, so a changed configuration re-runs this on switch.
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecCondition = "${lib.getExe' pkgs.systemd "systemctl"} is-active --quiet ${ownUnit}";
            ExecStart = "${lib.getExe engine} apply ${specFile tname t} ${backupDir}";
            # before-images hold settings as the API returns them: root only
            StateDirectory = "arr-sync";
            StateDirectoryMode = "0700";
            UMask = "0077";
            # Reads SOPS secret files and the app's database; only talks to localhost APIs.
            NoNewPrivileges = true;
            PrivateTmp = true;
            ProtectHome = true;
            ProtectSystem = "strict";
          };
        }
      ) cfg.targets;
  };
}
