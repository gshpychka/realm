{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.zsh;
in
{
  options.my.zsh = {
    enable = lib.mkEnableOption "Zsh shell configuration";
  };

  config = lib.mkIf cfg.enable {
    programs.starship = {
      enable = true;
      enableZshIntegration = true;
      settings = {
        add_newline = false;
        character = {
          success_symbol = "[➜](bold green) ";
          error_symbol = "[✗](bold red) ";
        };

        directory = {
          # disable directory when in a git repo
          repo_root_style = "";
          before_repo_root_style = "";
          repo_root_format = "";
        };

        custom =
          let
            # display a vendor-specific icon for git repos
            generateGitHostIconModule = host: symbol: color: {
              when = "${lib.getExe pkgs.git} config --get remote.origin.url | grep -q ${host}";
              require_repo = true;
              command = "";
              style = color;
              inherit symbol;
              description = "Custom icon for ${host}";
            };
          in
          {
            github = generateGitHostIconModule "github" " " "#4078c0"; # nf-dev-github
            gitlab = generateGitHostIconModule "gitlab" " " "#fc6d26"; # nf-dev-gitlab
            repo_name = {
              description = "Name of the current git repository";
              command =
                "basename \"$(${lib.getExe pkgs.git} config --get remote.origin.url)\"" + "| sed 's/\\.git$//'";
              # no space after
              format = "[$symbol($output)]($style)";
              when = true;
              require_repo = true;
            };
            git_directory = {
              description = "directory relative to the root of the git repo";
              # strip the last slash
              command = "${lib.getExe pkgs.git} rev-parse --show-prefix | sed 's:/*$::'";
              when = true;
              require_repo = true;
              format = "[$symbol($output) ]($style)";
              symbol = "/";
              style = "bold cyan";
            };
          };

        env_var = {
          AWS_PROFILE = {
            variable = "AWS_PROFILE";
            format = "[$env_value $symbol]($style) ";
            symbol = " "; # nf-dev-aws
            style = "#FF9900"; # AWS orange
          };
        };

        nix_shell = {
          # just the symbol
          format = "[$symbol ]($style)";
          style = "#7EBAE4";
          symbol = "󱄅 "; # nf-md-nix
        };

        hostname = {
          ssh_only = false;
          format = "[$hostname]($style)";
        };

        # this seems to be the only way to move "custom" to the top
        format = builtins.concatStringsSep "" [
          "$directory"
          "$\{custom.github}"
          "$\{custom.gitlab}"
          "$\{custom.repo_name}"
          "$\{custom.git_directory}"
          "$git_branch"
          "$git_state"
          "$git_status"
          "$docker_context"
          "$lua"
          "$python"
          "$terraform"
          "$nix_shell"
          "$sudo"
          "$character"
        ];
        right_format = builtins.concatStringsSep "" [
          "$\{env_var.AWS_PROFILE}"
          "$hostname"
        ];
      };
    };

    # pretty ls
    programs.lsd = {
      enable = true;
      enableZshIntegration = true;
      settings = {
        total-size = true;
      };
    };

    programs.dircolors = {
      enable = true;
      settings = {
        OTHER_WRITABLE = "30";
      };
    };

    programs.bat = {
      enable = true;
      config = {
        theme = "gruvbox-dark";
      };
    };

    programs.fzf = {
      enable = true;
      fileWidget = {
        command = "${lib.getExe pkgs.fd} --type f --strip-cwd-prefix";
      };
      changeDirWidget = {
        command = "${lib.getExe pkgs.fd} --type d --strip-cwd-prefix";
      };
      defaultOptions = [
        "--border sharp"
        "--inline-info"
        "--bind ctrl-h:preview-down,ctrl-l:preview-up"
      ];
    };

    home.sessionVariables.FAST_WORK_DIR = "${config.xdg.configHome}/fsh";

    # theme loaded by fast-syntax-highlighting
    xdg.configFile."fsh/current_theme.zsh".source = ./fsh-gruvbox-dark.zsh;
    # blocks fast-syntax-highlighting's GitHub download
    xdg.configFile."fsh/secondary_theme.zsh".text = "";

    programs.zsh = {
      enable = true;
      enableCompletion = true;
      autocd = true;
      dotDir = "${config.xdg.configHome}/zsh";
      defaultKeymap = "viins";
      autosuggestion = {
        enable = true;
        highlight = "fg=#928374"; # gruvbox grey
        strategy = [
          "history"
          "completion"
        ];
      };

      history = {
        expireDuplicatesFirst = true;
        ignoreSpace = true; # ignore commands starting with a space
        save = 20000;
        size = 20000;
        append = true;
        share = false;
      };
      historySubstringSearch = {
        enable = true;
      };

      shellAliases = lib.mkMerge [
        {
          # cd to the root of the git repo
          cdr = "cd $(git rev-parse --show-toplevel)";
          # remove all docker images, unused volumes and the build cache
          docker-clean = "docker rmi -f $(docker images -aq); docker volume prune -f; docker builder prune -af";
        }
        (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
          dns-flush = "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder";
        })
      ];

      initContent = /* bash */ ''
        bindkey '^E' autosuggest-accept

        # delete past insert start in insert mode
        bindkey -M viins '^?' backward-delete-char # If Backspace sends DEL (127)
        bindkey -M viins '^H' backward-delete-char # If Backspace sends Ctrl-H

        # vi-mode cursor shape via DECSCUSR escape sequences
        _set_vi_cursor_shape() {
          case ''${KEYMAP-} in
            vicmd|visual) print -n '\e[2 q' ;; # steady block
            *)            print -n '\e[6 q' ;; # steady bar
          esac
        }
        zle -N zle-keymap-select _set_vi_cursor_shape
        zle -N zle-line-init _set_vi_cursor_shape

        # A remote program (tmux, nvim) whose SSH connection drops never sends
        # the sequences that undo the input modes it enabled, so they persist in
        # the local terminal:
        # - mouse reporting: ZLE's vi keymap swallows the reports, but a
        #   cooked-mode tty (e.g. the next ssh while it authenticates) echoes
        #   them as ^[[<35;x;yM
        # - extended keyboard encoding: keys arrive as escape sequences, whose
        #   leading ESC switches ZLE from viins to vicmd
        # After ssh exits, this turns off X10/normal/button/any-event mouse
        # tracking and SGR encoding, resets xterm modifyOtherKeys, and sets the
        # kitty keyboard protocol flags to 0.
        ssh() {
          command ssh "$@"
          local rc=$?
          # /dev/tty keeps the sequences out of redirected output
          print -n '\e[?9l\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[>4m\e[=0;1u' 2>/dev/null >/dev/tty
          return $rc
        }

        function cd() {
          builtin cd "$@" && ls
        }

        nixp() {
          local packages=()
          for pkg in "$@"; do
              packages+=("github:NixOS/nixpkgs#$pkg")
          done
          # needed because it doesn't respect the system-wide config
          NIXPKGS_ALLOW_UNFREE=1 nix shell --impure "''${packages[@]}"
        }

        # Wrap granted so it's sourced.
        # GRANTED_ALIAS_CONFIGURED makes granted emit its machine-readable
        # export line — its own detection only fires for aliases, not functions.
        assume() {
          local bin
          bin="$(whence -p assume)"
          if [[ -z "$bin" ]]; then
            print -u2 "assume: no 'assume' binary on PATH — enter a devshell that provides it"
            return 1
          fi
          export GRANTED_ALIAS_CONFIGURED=true
          source "$bin" "$@"
        }

        # fzf history search with prefix filtering
        # when ctrl+r is pressed:
        # - empty buffer: fuzzy search all history
        # - with text: find only commands that start with the text, then fuzzy search among them
        fzf-history-widget-custom() {
          local selected
          
          if [[ -z "$BUFFER" ]]; then
            # empty command line - default(-ish) behavior
            selected=$(
              fc -rl 1 |
              ${lib.getExe pkgs.gawk} '
                {
                  # remove line number
                  $1="";
                  # print without leading space
                  print substr($0,2)
                }' |
              ${lib.getExe pkgs.fzf} --tac --no-sort
            )
          else
            # command line has text - filter by prefix before fuzzy search
            local prefix="$BUFFER"
            
            selected=$(
              fc -rl 1 |
              ${lib.getExe pkgs.gawk} -v prefix="$prefix" '
                {
                  # remove line number
                  $1="";
                  # get command without leading space
                  line=substr($0,2);
                  # print if starts with prefix
                  if (substr(line,1,length(prefix))==prefix) 
                    print line
                }' |
              ${lib.getExe pkgs.fzf} \
                  --tac \
                  --no-sort \
                  --query=''${prefix#* }
            )
          fi
          
          # update command line with selection, if any
          if [[ -n "$selected" ]]; then
            # replace command line
            BUFFER="$selected"
            # move cursor to end
            CURSOR=$#BUFFER
          fi
          
          # refresh the command line display
          zle redisplay
        }

        # register the function
        zle -N fzf-history-widget-custom

        # bind ctrl+R (overrides default fzf binding)
        bindkey '^R' fzf-history-widget-custom
      '';

      plugins = [
        {
          name = "fast-syntax-highlighting";
          file = "fast-syntax-highlighting.plugin.zsh";
          src = "${pkgs.zsh-fast-syntax-highlighting}/share/zsh/plugins/fast-syntax-highlighting";
        }
        {
          name = "zsh-nix-shell";
          file = "nix-shell.plugin.zsh";
          src = "${pkgs.zsh-nix-shell}/share/zsh-nix-shell";
        }
      ];
    };
  };
}
