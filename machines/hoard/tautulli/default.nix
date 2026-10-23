{
  config,
  lib,
  pkgs,
  ...
}:
# Tautulli with declared settings and notification agents.
#
# Tautulli keeps everything in its own state: settings in config.ini, and
# notifiers next to the watch history in tautulli.db. Neither is replaced:
# - configure.py runs before every start and re-asserts the declared settings
#   and SOPS secrets in config.ini; Tautulli may still write the file at
#   runtime, and keys not declared here (server identifiers, upgrade flags)
#   stay Tautulli's. A UI change to a declared key lasts until the next start.
# - reconcile.py runs after every start and converges the declared notifiers
#   through Tautulli's own API, keyed by their database ids. It never sends a
#   notification and never touches history, users, sessions or metadata.
# Both are no-ops when nothing differs. See the scripts for the API quirks and
# the secret adoption rule (no rotation of a differing live value).
#
# The tests (fake API, synthetic secrets) run as part of building hoard.
#
# Verify after a deploy (no notifications are sent by any of this):
#   systemctl status tautulli tautulli-notifiers
#   journalctl -b -u tautulli -u tautulli-notifiers | grep -E 'tautulli-(configure|notifiers)'
#   # expect "config.ini already converged" and "changes=0"; a "differs from
#   # credential" line means a SOPS value doesn't match the live one and the
#   # live one was kept: fix the SOPS value, then restart tautulli
# Before a deploy that changes a credential, compare SOPS with live read-only:
# run the built configure.py/reconcile.py "preview" (see their usage) as root
# with $CREDENTIALS_DIRECTORY holding the decrypted SOPS values; non-zero
# means a working live credential would be kept as mismatched or replaced.
# The first start keeps a copy of config.ini and tautulli.db in
# /var/lib/plexpy/backups/pre-declarative-<UTC>/ (0600, service user only).
let
  inherit ((import ../ports.nix { inherit config; })) ports;
  cfg = config.services.tautulli;
  python = lib.getExe pkgs.python3;

  # sops secret names double as systemd credential names
  credentials = {
    # existing secrets/hoard/secrets.yaml entry
    apiKey = "tautulli-api-key";
    # secrets/openclaw/tautulli.yaml, migrated from the live config.ini/database
    # Tautulli's own Plex token (the server owner's), not the shared
    # plex-token: on 2026-10-16 that one was rejected by Plex (401) while
    # Tautulli's live token worked, so the live one was migrated as is
    plexToken = "tautulli-plex-token";
    httpUsername = "tautulli-http-username";
    # the stored PBKDF2 hash (http_hashed_password), not a plaintext password
    httpPassword = "tautulli-http-password";
    jwtSecret = "tautulli-jwt-secret";
    themoviedbApiKey = "tautulli-themoviedb-api-key";
    telegramBotToken = "tautulli-telegram-bot-token";
    # the media group's id, and the private chat the legacy notifier pointed at
    telegramGroupChatId = "tautulli-telegram-group-chat-id";
    telegramLegacyChatId = "tautulli-telegram-legacy-chat-id";
  };
  migratedSecrets = with credentials; [
    plexToken
    httpUsername
    httpPassword
    jwtSecret
    themoviedbApiKey
    telegramBotToken
    telegramGroupChatId
    telegramLegacyChatId
  ];

  # config.ini values Tautulli is configured with, by section. Flags are bools
  # (written as 1/0); keys Tautulli derives at runtime are deliberately absent.
  settings = {
    General = {
      allow_guest_access = false;
      date_format = "YYYY-MM-DD";
      time_format = "HH:mm";
      anon_redirect = "";
      anon_redirect_dynamic = false;
      api_enabled = true;
      api_sql = false;
      backup_days = 3;
      backup_dir = "${cfg.dataDir}/backups";
      backup_interval = 6;
      cache_dir = "${cfg.dataDir}/cache";
      cache_images = true;
      # updates come from nixpkgs
      check_github = false;
      check_github_interval = 6;
      check_github_on_startup = true;
      plexpy_auto_update = false;
      cleanup_files = false;
      enable_https = false;
      https_create_cert = true;
      https_cert = "${cfg.dataDir}/server.crt";
      https_cert_chain = "";
      https_key = "${cfg.dataDir}/server.key";
      https_domain = "localhost";
      https_ip = "127.0.0.1";
      export_dir = "${cfg.dataDir}/exports";
      freeze_db = false;
      get_file_sizes = true;
      group_history_tables = true;
      history_table_activity = true;
      home_sections = [
        "current_activity"
        "watch_stats"
        "library_stats"
        "recently_added"
      ];
      home_library_cards = [
        1
        2
        3
      ];
      home_stats_cards = [
        "top_movies"
        "popular_movies"
        "top_tv"
        "popular_tv"
        "top_music"
        "popular_music"
        "last_watched"
        "top_libraries"
        "top_users"
        "top_platforms"
        "most_concurrent"
      ];
      home_refresh_interval = 10;
      # Tautulli's own login (frontend.nix: auth = "native")
      http_basic_auth = false;
      http_hash_password = true;
      http_hashed_password = true;
      http_plex_admin = true;
      http_environment = "production";
      http_host = "0.0.0.0";
      http_port = cfg.port;
      http_proxy = true;
      http_root = "";
      # public hostname through the Cloudflare tunnel (frontend.nix)
      http_base_url = "https://tautulli.${config.networking.domain}";
      http_rate_limit_attempts = 10;
      http_rate_limit_attempts_interval = 300;
      http_rate_limit_lockout_time = 300;
      http_thread_pool = 10;
      interface = "default";
      launch_browser = false;
      launch_startup = false;
      log_blacklist = true;
      log_blacklist_usernames = false;
      log_dir = "${cfg.dataDir}/logs";
      musicbrainz_lookup = false;
      show_advanced_settings = true;
      themoviedb_lookup = true;
      tvmaze_lookup = false;
      update_db_interval = 24;
      update_show_changelog = true;
      week_start_monday = true;
      sys_tray_icon = false;
    };
    PMS = {
      # Plex runs in the wan2 network namespace (networking.nix)
      pms_ip = config.my.netns.wan2.namespaceAddress;
      pms_port = ports.plex;
      pms_ssl = false;
      pms_is_remote = false;
      pms_url_manual = false;
      pms_url_override = "";
      pms_logs_folder = "${config.services.plex.dataDir}/Plex Media Server/Logs";
      pms_logs_line_cap = 1000;
      pms_language = "";
      pms_name_override = "";
      pms_use_bif = false;
      pms_web_url = "https://app.plex.tv/desktop";
      pms_update_channel = "plex";
    };
    Advanced = {
      pms_timeout = 15;
      pms_update_check_interval = 24;
      cache_sizemb = 32;
      check_docker_mount = true;
      check_github_cache_seconds = 3600;
      export_threads = 8;
      https_min_tls_version = "TLSv1.2";
      journal_mode = "WAL";
      metadata_cache_seconds = 1800;
      notification_threads = 2;
      notify_text_eval = false;
      session_db_write_attempts = 5;
      synchronous_mode = "NORMAL";
      verbose_logs = true;
      verify_ssl_cert = true;
      websocket_monitor_ping_pong = false;
      websocket_connection_attempts = 5;
      websocket_connection_timeout = 5;
      system_analytics = true;
      allow_mounted_folders = false;
      remote_app_push_url = "https://relay.tautulliremote.com";
      x_frame_options = "SAMEORIGIN";
    };
    Monitoring = {
      buffer_threshold = 10;
      buffer_wait = 900;
      imgur_client_id = "";
      logging_ignore_interval = 120;
      movie_watched_percent = 85;
      music_watched_percent = 85;
      tv_watched_percent = 85;
      monitor_pms_updates = false;
      monitoring_interval = 60;
      notify_consecutive = true;
      notify_continued_session_threshold = 15;
      notify_group_recently_added_grandparent = false;
      notify_group_recently_added_parent = true;
      # 0 disabled, 1 Imgur, 2 self-hosted on the public domain, 3 Cloudinary
      notify_upload_posters = 2;
      notify_recently_added_delay = 60;
      notify_recently_added_grandparent = false;
      notify_recently_added_upgrade = false;
      notify_remote_access_threshold = 60;
      notify_concurrent_by_ip = false;
      notify_concurrent_ipv6_cidr = "/64";
      notify_concurrent_threshold = 2;
      notify_new_device_initial_only = true;
      notify_server_connection_threshold = 60;
      notify_server_update_repeat = false;
      notify_plexpy_update_repeat = false;
      refresh_libraries_interval = 12;
      refresh_libraries_on_startup = true;
      refresh_users_interval = 12;
      refresh_users_on_startup = true;
      watched_marker = 3;
    };
    Cloudinary = {
      cloudinary_cloud_name = "";
      cloudinary_api_key = "";
      cloudinary_api_secret = "";
    };
    Newsletter = {
      newsletter_auth = false;
      newsletter_password = "";
      newsletter_custom_dir = "";
      newsletter_inline_styles = true;
      newsletter_templates = "newsletters";
      newsletter_dir = "${cfg.dataDir}/newsletters";
      newsletter_self_hosted = false;
    };
  };

  iniSecrets = with credentials; [
    {
      section = "General";
      key = "api_key";
      credential = apiKey;
    }
    {
      section = "PMS";
      key = "pms_token";
      credential = plexToken;
    }
    {
      section = "General";
      key = "http_username";
      credential = httpUsername;
    }
    {
      section = "General";
      key = "http_password";
      credential = httpPassword;
    }
    {
      section = "Advanced";
      key = "jwt_secret";
      credential = jwtSecret;
    }
    {
      section = "General";
      key = "themoviedb_apikey";
      credential = themoviedbApiKey;
    }
  ];

  # Telegram notifiers. Ids are Tautulli's database ids and stay stable; the
  # agent config is declared completely, every action not listed is off, and
  # templates not listed are Tautulli's defaults.
  telegram = {
    # forum topics of the media group (Maintainerr also posts to Status)
    topics = {
      status = 22;
      tvShows = 16;
      movies = 15;
    };
    groupTopic = topic: {
      credential = credentials.telegramGroupChatId;
      suffix = "/${toString telegram.topics.${topic}}";
    };
    config = {
      disable_web_preview = false;
      silent_notification = true;
      html_support = true;
      incl_subject = false;
    };
    botToken.credential = credentials.telegramBotToken;
  };
  noConditions = {
    custom_conditions = [ ];
    custom_conditions_logic = "";
  };
  library = name: {
    parameter = "library_name";
    operator = "is";
    value = [ name ];
  };
  episodeCount = operator: {
    parameter = "episode_count";
    inherit operator;
    value = [ "1" ];
  };
  statusTexts = {
    on_error = {
      subject = "Plex ({server_name})";
      body = "{user} ({player}) виникла помилка під час програвання {title}.";
    };
    on_extdown = {
      subject = "Plex ({server_name})";
      body = "Сервер недоступний. ({remote_access_reason})";
    };
    on_extup = {
      subject = "Plex ({server_name})";
      body = "Сервер знову доступний";
    };
  };
  createdSubject = "Plex ({server_name})";
  telegramNotifier =
    {
      id,
      friendly_name,
      poster,
      chat_id,
      actions,
      text,
      conditions ? noConditions,
    }:
    {
      inherit
        id
        friendly_name
        actions
        text
        ;
      agent = "telegram";
      config = telegram.config // {
        incl_poster = poster;
      };
      secret_config = {
        bot_token = telegram.botToken;
        inherit chat_id;
      };
    }
    // conditions;

  notifiers = map telegramNotifier [
    # the original private-chat notifier, all actions off; kept as it was
    {
      id = 1;
      friendly_name = "";
      poster = true;
      chat_id.credential = credentials.telegramLegacyChatId;
      actions = [ ];
      text = {
        on_buffer = {
          subject = "Plex {server_name}";
          body = "У {user} лагає {title} :(";
        };
        on_created = {
          subject = "{server_name}";
          body = "{title} доступно для перегляду";
        };
        on_intdown.subject = "{server_name}";
        on_intup.subject = "{server_name}";
        on_extdown = {
          subject = "Plex {server_name}";
          body = "Сервер недоступний ({remote_access_reason})";
        };
        on_extup = {
          subject = "Plex {server_name}";
          body = "Сервер знову доступний";
        };
      };
    }
    {
      id = 2;
      # two spaces, as named in the UI
      friendly_name = "Telegram  - Status";
      poster = false;
      chat_id = telegram.groupTopic "status";
      actions = [
        "on_error"
        "on_extdown"
        "on_extup"
        "on_plexpydbcorrupt"
        "on_tokenexpired"
      ];
      text = statusTexts;
    }
    {
      id = 3;
      friendly_name = "Telegram - Одна серія серіалу";
      poster = true;
      chat_id = telegram.groupTopic "tvShows";
      actions = [ "on_created" ];
      text = statusTexts // {
        on_created = {
          subject = createdSubject;
          body = "{show_name}<season> - Сезон {season_num}</season><episode> - S{season_num}E{episode_num} - {episode_name}</episode> доступно до перегляду";
        };
      };
      conditions = noConditions // {
        custom_conditions = [
          (library "TV Shows")
          (episodeCount "is")
        ];
      };
    }
    {
      id = 4;
      friendly_name = "Telegram - Фільми";
      poster = true;
      chat_id = telegram.groupTopic "movies";
      actions = [ "on_created" ];
      text = statusTexts // {
        on_created = {
          subject = createdSubject;
          body = "{title} доступно до перегляду";
        };
      };
      conditions = noConditions // {
        custom_conditions = [ (library "Movies") ];
      };
    }
    {
      id = 5;
      friendly_name = "Telegram - Декілька серій серіалу";
      poster = true;
      chat_id = telegram.groupTopic "tvShows";
      actions = [ "on_created" ];
      text = statusTexts // {
        on_created = {
          subject = createdSubject;
          body = "{show_name}<season> - Сезон {season_num} Серії {episode_num}</season><episode> - S{season_num}E{episode_num} - {episode_name}</episode> доступні до перегляду";
        };
      };
      conditions = noConditions // {
        custom_conditions = [
          (library "TV Shows")
          (episodeCount "is greater than")
        ];
      };
    }
  ];

  settingsFile = pkgs.writeText "tautulli-settings.json" (
    builtins.toJSON {
      inherit settings;
      secrets = iniSecrets;
    }
  );
  notifiersFile = pkgs.writeText "tautulli-notifiers.json" (
    builtins.toJSON {
      inherit notifiers;
      api_key_credential = credentials.apiKey;
    }
  );

  # the schema is read from the running Tautulli package, so a version bump
  # that renames a setting or action fails the build instead of the service
  scripts =
    pkgs.runCommand "tautulli-declarative"
      {
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.fileFilter (file: file.hasExt "py") ./.;
        };
        nativeBuildInputs = [ pkgs.python3 ];
      }
      ''
        mkdir $out
        cp $src/configure.py $src/reconcile.py $out/
        python3 -I $src/schema.py ${cfg.package}/libexec/tautulli/plexpy > $out/schema.json
        python3 -I $out/configure.py check ${settingsFile} $out/schema.json
        python3 -I $out/reconcile.py check ${notifiersFile} $out/schema.json
        cp $src/configure.py $src/test_configure.py .
        python3 test_configure.py
      '';
  # the configobj copy Tautulli itself reads and writes config.ini with
  configobjDir = "${cfg.package}/libexec/tautulli/lib";

  loadCredentials = names: map (name: "${name}:${config.sops.secrets.${name}.path}") names;
  tautulliUnit = config.systemd.services.tautulli.name;
in
{
  system.build.tautulliConfig = scripts;

  assertions = [
    {
      # StateDirectory= below owns the permissions of the data directory
      assertion = lib.hasPrefix "/var/lib/" cfg.dataDir;
      message = "tautulli: dataDir must live under /var/lib";
    }
  ];

  services.tautulli.enable = true;

  systemd.services = {
    tautulli = {
      after = [ config.systemd.services.plex.name ];
      serviceConfig = {
        # the data dir holds every Tautulli secret: service user only
        StateDirectory = lib.removePrefix "/var/lib/" cfg.dataDir;
        StateDirectoryMode = "0700";
        UMask = "0077";
        LoadCredential = loadCredentials (map (secret: secret.credential) iniSecrets);
        ExecStartPre = "${python} -I ${scripts}/configure.py apply ${settingsFile} ${scripts}/schema.json ${configobjDir} ${cfg.dataDir} ${cfg.configFile}";
      };
    };

    tautulli-notifiers = {
      description = "Reconcile Tautulli notification agents";
      # re-run with every Tautulli (re)start, and on changes of this unit
      wantedBy = [ tautulliUnit ];
      partOf = [ tautulliUnit ];
      after = [ tautulliUnit ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = cfg.user;
        Group = cfg.group;
        # waits for the API to come up
        TimeoutStartSec = "6min";
        LoadCredential = loadCredentials (
          [ credentials.apiKey ]
          ++ lib.unique (
            lib.concatMap (n: map (secret: secret.credential) (lib.attrValues n.secret_config)) notifiers
          )
        );
        ExecStart = "${python} -I ${scripts}/reconcile.py apply ${notifiersFile} ${scripts}/schema.json http://127.0.0.1:${toString cfg.port} ${cfg.dataDir}/declarative-secrets.json";
        # reads its credentials and configure.py's state file, talks to localhost
        UMask = "0077";
        CapabilityBoundingSet = "";
        IPAddressAllow = "localhost";
        IPAddressDeny = "any";
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
      };
    };
  };

  sops.secrets = {
    ${credentials.apiKey}.restartUnits = [ tautulliUnit ];
  }
  // lib.genAttrs migratedSecrets (_: {
    sopsFile = ../../../secrets/openclaw/tautulli.yaml;
    restartUnits = [ tautulliUnit ];
  });
}
