{
  config,
  lib,
  osConfig,
  pkgs,
  ...
}:
let
  cfg = config.my.clipboard;
  # The server's socket on the sharing machine, and the SSH-forwarded socket in a reading host's home.
  socket = home: "${home}/.ssh/clipboard.sock";

  # Answers one request per connection with stdin and stdout on the socket.
  # A request names an xclip target: TARGETS lists the image types on offer, image/png reads the image.
  server = pkgs.writeShellApplication {
    name = "clipboard-server";
    runtimeInputs = [ pkgs.pngpaste ];
    text = ''
      # keep diagnostics off stderr, which launchd connects to the client socket
      exec 2>/dev/null
      # the requested target
      read -r target
      # whether the client asks for the type list
      if [ "$target" = TARGETS ]; then
        # whether the pasteboard holds an image, checked without encoding it
        if [ "$(/usr/bin/osascript -l JavaScript -e 'ObjC.import("AppKit"); $.NSImage.canInitWithPasteboard($.NSPasteboard.generalPasteboard)')" = true ]; then
          # offer the image as PNG
          echo image/png
        fi
      # whether the client asks for the image
      elif [ "$target" = image/png ]; then
        # write the pasteboard image as PNG
        pngpaste -
      fi
    '';
  };

  # An xclip whose clipboard reads of TARGETS and image/png come from the SSH client machine's server.
  xclip = pkgs.writeShellApplication {
    name = "xclip";
    runtimeInputs = [ pkgs.socat ];
    text = ''
      # the target the caller reads, set by -t
      target=
      # whether the caller reads the clipboard, set by -o
      reading=
      # walk the arguments
      while [ $# -gt 0 ]; do
        # match the current argument
        case "$1" in
          # whether the caller names the CLIPBOARD selection
          -selection) [ "$2" = clipboard ] || exit 1; shift ;;
          # the caller reads
          -o) reading=1 ;;
          # the caller names the target
          -t) target=$2; shift ;;
          # reject any other argument, such as a write
          *) exit 1 ;;
        esac
        # move to the next argument
        shift
      done
      # whether this is a read of a target the server answers
      case "$reading:$target" in
        # such a read goes ahead
        1:TARGETS | 1:image/png) ;;
        # anything else fails, as an unavailable target does
        *) exit 1 ;;
      esac
      # send the target to the client machine's server and relay the reply, waiting up to 30s for it after the request
      exec socat -t 30 - UNIX-CONNECT:${socket config.home.homeDirectory} <<<"$target"
    '';
  };
in
{
  options.my.clipboard = {
    shareWith = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Fleet hosts where SSH sessions from this machine read its clipboard images";
    };
    readFromClient = lib.mkEnableOption "reading clipboard images from the machine an SSH session comes from";
  };

  config = lib.mkMerge [
    (lib.mkIf (cfg.shareWith != [ ]) {
      launchd.agents.clipboard = {
        enable = true;
        config = {
          ProgramArguments = [ (lib.getExe server) ];
          Sockets.clipboard = {
            SockPathName = socket config.home.homeDirectory;
            # 0600
            SockPathMode = 384;
          };
          # launchd accepts each connection and runs the server on it
          inetdCompatibility.Wait = false;
        };
      };
      # The reading hosts keep the user's home under /home.
      my.ssh.hostSettings = lib.genAttrs cfg.shareWith (_: {
        RemoteForward = {
          bind.address = socket "/home/${osConfig.my.user}";
          host.address = socket config.home.homeDirectory;
        };
      });
    })
    (lib.mkIf cfg.readFromClient {
      home.packages = [ xclip ];
    })
  ];
}
