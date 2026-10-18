{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit ((import ../ports.nix { inherit config; })) ports;
  # Pin the running image: the tiny compatibility patch is reviewed for this
  # exact build and fails closed when upstream changes. No broad version upgrade.
  image = "ghcr.io/maintainerr/maintainerr@sha256:014fcae5d4cfae96bfb239ebe9368751549e9516947435f4e07520add92cf19e";
  patchDir = "/run/maintainerr-notification-patch";
  notificationFiles = ./maintainerr-notifications;
  statusNotification = pkgs.writeText "maintainerr-status-notification.json" (
    builtins.toJSON {
      baseUrl = "http://127.0.0.1:${toString ports.maintainerr}/api";
      name = "Telegram - Maintainerr failures";
      credentialSourceName = "Telegram";
      messageThreadId = 22; # existing media group's Status topic
      # rule / collection handling failures only
      types = [
        32
        64
      ];
    }
  );
in
{
  users = {
    groups = {
      maintainerr = {
        gid = 994;
      };
      media = {
        # we need there to be a GID, but we don't care which one
        gid = lib.mkDefault 993;
      };
    };
    users = {
      maintainerr = {
        uid = 994;
        group = config.users.groups.maintainerr.name;
        extraGroups = [ config.users.groups.media.name ];
        isSystemUser = true;
      };
    };
  };
  virtualisation.oci-containers.containers.maintainerr = {
    inherit image;
    volumes = [
      "/var/lib/maintainerr:/opt/data"
      "${patchDir}/collection-handler.js:/opt/app/apps/server/dist/modules/collections/collection-handler.js:ro"
      "${patchDir}/collections.service.js:/opt/app/apps/server/dist/modules/collections/collections.service.js:ro"
      "${patchDir}/rule-executor.service.js:/opt/app/apps/server/dist/modules/rules/tasks/rule-executor.service.js:ro"
      "${patchDir}/telegram.js:/opt/app/apps/server/dist/modules/notifications/agents/telegram.js:ro"
    ];
    environment = {
      TZ = config.time.timeZone;
      UI_PORT = toString ports.maintainerr;
      UI_HOST = "127.0.0.1";
    };
    # need to refer by ID because these names don't exist in the container
    user = "${toString config.users.users.maintainerr.uid}:${toString config.users.groups.maintainerr.gid}";
    extraOptions = [
      # host networking to give us access to localhost
      # this also means we don't need to map ports
      "--network=host"
      # secondary group for the user
      "--group-add=${toString config.users.groups.media.gid}"
    ];
  };

  # Only notification event emission / optional Telegram topic routing differs.
  # Extract from an unstarted image, verify hashes, and bind the four patched
  # modules read-only. Cancellation notices survive.
  systemd.services.docker-maintainerr = {
    serviceConfig = {
      RuntimeDirectory = "maintainerr-notification-patch";
      RuntimeDirectoryMode = "0755";
    };
    preStart = lib.mkAfter ''
      ${pkgs.docker}/bin/docker image inspect ${image} >/dev/null 2>&1 || ${pkgs.docker}/bin/docker pull ${image}
      temp=$(mktemp -d ${patchDir}/source.XXXXXX)
      source=$(${pkgs.docker}/bin/docker create --entrypoint /bin/true ${image})
      trap '${pkgs.docker}/bin/docker rm "$source" >/dev/null; rm -rf "$temp"' EXIT
      ${pkgs.docker}/bin/docker cp "$source:/opt/app/apps/server/dist/modules/collections/collection-handler.js" "$temp/collection-handler.js"
      ${pkgs.docker}/bin/docker cp "$source:/opt/app/apps/server/dist/modules/collections/collections.service.js" "$temp/collections.service.js"
      ${pkgs.docker}/bin/docker cp "$source:/opt/app/apps/server/dist/modules/rules/tasks/rule-executor.service.js" "$temp/rule-executor.service.js"
      ${pkgs.docker}/bin/docker cp "$source:/opt/app/apps/server/dist/modules/notifications/agents/telegram.js" "$temp/telegram.js"
      ${pkgs.nodejs}/bin/node ${notificationFiles}/patch.cjs "$temp"
      for file in collection-handler.js collections.service.js rule-executor.service.js telegram.js; do
        ${pkgs.nodejs}/bin/node --check "$temp/$file"
        install -m 0444 "$temp/$file" "${patchDir}/$file"
      done
    '';
    # Credentials stay in existing private state; reconcile this one owned
    # notifier over the native API, never rewrite SQLite or import rule state.
    postStart = ''
      ${pkgs.nodejs}/bin/node --no-warnings ${notificationFiles}/reconcile.cjs ${statusNotification}
    '';
  };

  systemd.tmpfiles.rules = [
    "d /var/lib/maintainerr 0755 ${config.users.users.maintainerr.name} ${config.users.groups.maintainerr.name} -"
  ];
}
