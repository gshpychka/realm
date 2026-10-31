# Fleet notifications: each sender host publishes to one private ntfy topic on
# buoy (machines/buoy/ntfy.nix) as its own write-only account. The token lives
# in secrets/notifications/<host>.yaml, readable by that host and buoy.
#
# New sender:
#   add a secrets/notifications/<host>.yaml rule to .sops.yaml
#   generate and encrypt the host's token and throwaway password hash (ntfy requires
#   a bcrypt hash per account; senders authenticate with the token):
#     h=<host>
#     token="tk_$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 29)"
#     hash=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40 \
#       | nix shell nixpkgs#apacheHttpd -c htpasswd -niBC 10 "" | tr -d ':\n')
#     printf 'ntfy-token: %s\nntfy-password-hash: %s\n' "$token" "$hash" \
#       | sops --encrypt --filename-override secrets/notifications/$h.yaml \
#           --input-type yaml --output-type yaml /dev/stdin > secrets/notifications/$h.yaml
#   add the host to senders, then deploy buoy before the host.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.notifications;
  inherit (config.networking) hostName;
in
{
  options.my.notifications = {
    senders = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      readOnly = true;
      description = "Hosts that publish notifications, each with its own ntfy account on buoy";
    };

    topic = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      description = "ntfy topic every host publishes notifications to";
    };

    server = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      description = "ntfy server the notifications topic lives on";
    };

    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      description = ''
        The `notify` command: `notify [-p PRIORITY] [-t TAGS] TITLE [MESSAGE]`.
        PRIORITY is ntfy's 1-5 (default 3), TAGS a comma-separated list of ntfy
        tags or emoji shortcodes, and MESSAGE defaults to stdin. It reads the
        host's token, so callers run as root.
      '';
    };
  };

  config = lib.mkMerge [
    {
      my.notifications = {
        senders = [
          "buoy"
          "eve"
          "harbor"
          "hoard"
          "reaper"
        ];
        topic = "notifications";
        server = "https://ntfy.${config.my.domain}";
      };
    }

    (lib.mkIf (lib.elem hostName cfg.senders) {
      sops.secrets.notifications-ntfy-token = {
        sopsFile = ../../../secrets/notifications/${hostName}.yaml;
        key = "ntfy-token";
      };
      # a header file keeps the token out of curl's argv, which other users can read
      sops.templates."notifications-ntfy-auth-header".content =
        "Authorization: Bearer ${config.sops.placeholder.notifications-ntfy-token}";

      my.notifications.package = pkgs.writeShellApplication {
        name = "notify";
        runtimeInputs = [
          pkgs.curl
          pkgs.jq
        ];
        text = ''
          usage() {
            echo "usage: notify [-p PRIORITY] [-t TAGS] TITLE [MESSAGE]" >&2
            exit 2
          }

          priority=3
          tags=""
          while getopts p:t: opt; do
            case $opt in
              p) priority=$OPTARG ;;
              t) tags=$OPTARG ;;
              *) usage ;;
            esac
          done
          shift $((OPTIND - 1))
          [[ $priority =~ ^[1-5]$ ]] || usage
          (( $# == 1 || $# == 2 )) || usage

          title=$1
          if (( $# == 2 )); then message=$2; else message=$(cat); fi

          # JSON publishing carries non-ASCII titles that HTTP headers would mangle
          jq --null-input \
            --arg topic ${lib.escapeShellArg cfg.topic} \
            --arg title ${lib.escapeShellArg hostName}": $title" \
            --arg message "$message" \
            --argjson priority "$priority" \
            --arg tags "$tags" \
            '{$topic, $title, $message, $priority, tags: ($tags | split(",") | map(select(. != "")))}' \
          | curl --silent --show-error --fail-with-body --output /dev/null \
              --retry 5 --retry-all-errors --max-time 30 \
              --header @${config.sops.templates."notifications-ntfy-auth-header".path} \
              --data-binary @- ${lib.escapeShellArg cfg.server}
        '';
      };

      environment.systemPackages = [ cfg.package ];
    })
  ];
}
