{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pituitary;
  inherit (lib) mkEnableOption mkOption types;

  keybindingsFile = "${config.xdg.configHome}/pituitary/keybindings.json";

  environment = {
    PI_AGENT_CMD = cfg.agent.command;
    PITUITARY_FIRELIGHT = cfg.firelight.reach;
    PITUITARY_FIRELIGHT_STRENGTH = cfg.firelight.strength;
    PITUITARY_FIRELIGHT_ON = cfg.firelight.on;
    PITUITARY_FIRELIGHT_HAZE = cfg.firelight.haze;
    PITUITARY_FIRE_TRAVELS = if cfg.fire.travels then "on" else "off";
    PITUITARY_FIRE_COALS = cfg.fire.coals;
    PITUITARY_FIRE_COOLING = toString cfg.fire.cooling;
    PITUITARY_FIRE_SMOKE = toString cfg.fire.smoke;
    PITUITARY_FIRE_SPARKS = toString cfg.fire.sparks;
    PITUITARY_FIRE_WARMTH = cfg.fire.warmth;
    PITUITARY_FIRE_PILOT = if cfg.fire.pilot then "on" else "off";
    PITUITARY_FIRE_ASH = if cfg.fire.ash then "on" else "off";
    PITUITARY_FIRE_BURN = cfg.fire.burn;
    PITUITARY_FOOTER_SEPARATOR = cfg.footer.separator;
    PITUITARY_FOOTER_PALETTE = cfg.footer.palette;
    PITUITARY_FOOTER_HEARTH = toString cfg.footer.hearth;
  }
  // lib.optionalAttrs (cfg.agent.args != [ ]) {
    PI_AGENT_ARGS_JSON = builtins.toJSON cfg.agent.args;
  }
  // lib.optionalAttrs (cfg.nvimPackage != null) {
    PITUITARY_NVIM = lib.getExe' cfg.nvimPackage "nvim";
  }
  // lib.optionalAttrs (cfg.ghPackage != null) { PITUITARY_GH = lib.getExe' cfg.ghPackage "gh"; }
  // lib.optionalAttrs (cfg.glyphs == "plain") { PITUITARY_PLAIN_GLYPHS = "1"; }
  // lib.optionalAttrs (!cfg.animations) { PITUITARY_STILL = "1"; }
  // lib.optionalAttrs (cfg.editor != null) { PITUITARY_EDITOR = cfg.editor; }
  // lib.optionalAttrs (cfg.logFile != null) { PITUITARY_LOG = cfg.logFile; }
  // lib.optionalAttrs (cfg.profileFile != null) { PITUITARY_PROFILE = cfg.profileFile; }
  // lib.optionalAttrs (cfg.keybindings != { }) { PITUITARY_KEYBINDINGS = keybindingsFile; }
  // cfg.extraEnvironment;

  # The settings travel with the binary, so they reach pituitary and nothing else the shell runs.
  wrapped = pkgs.symlinkJoin {
    name = "pituitary-configured";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pituitary ${
        lib.concatStringsSep " " (
          lib.mapAttrsToList (
            name: value: "--set ${lib.escapeShellArg name} ${lib.escapeShellArg value}"
          ) environment
        )
      }
    '';
    meta.mainProgram = "pituitary";
  };
in
{
  options.programs.pituitary = {
    enable = mkEnableOption "pituitary, the OpenTUI frontend for the pi coding agent";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ../../packages/pituitary { };
      defaultText = lib.literalExpression "pkgs.callPackage ../../packages/pituitary { }";
      description = "The pituitary package the configured wrapper runs.";
    };

    nvimPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      example = lib.literalExpression "pkgs.neovim-unwrapped";
      description = ''
        The neovim that backs the vim-mode draft. `null` keeps the build the package pins.
        The draft runs it with `--clean`, so neither the user's config nor plugins load.
      '';
    };

    ghPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      example = lib.literalExpression "pkgs.gh";
      description = ''
        The GitHub CLI pituitary runs under the user's own `gh` login: the footer asks it
        for the current branch's pull request, and `/share` creates a secret gist with it.
        `null` keeps the build the package pins. Setting `extraEnvironment.PITUITARY_GH = ""`
        runs no gh, turning both off.
      '';
    };

    agent = {
      command = mkOption {
        type = types.str;
        default = "pi";
        example = "/etc/profiles/per-user/me/bin/pi";
        description = "The pi executable pituitary starts in RPC mode, looked up on PATH when it is a bare name.";
      };

      args = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [
          "--model"
          "claude-opus-5-5"
          "--thinking"
          "high"
        ];
        description = ''
          Arguments given to pi ahead of the ones on pituitary's command line. Each list item
          is one argument; spaces, quotes, and empty arguments are preserved.
        '';
      };
    };

    glyphs = mkOption {
      type = types.enum [
        "nerd-font"
        "plain"
      ];
      default = "nerd-font";
      description = "The interface's icon set: Nerd Fonts glyphs, or plain Unicode symbols for terminals without a Nerd Font.";
    };

    animations = mkOption {
      type = types.bool;
      default = true;
      description = "Whether the working indicator's fire moves. `false` holds it on one frame.";
    };

    fire = {
      travels = mkOption {
        type = types.bool;
        default = true;
        description = "Whether the fire leaves its corner for the working line while pi works. `false` keeps it in the corner.";
      };

      coals = mkOption {
        type = types.enum [
          "none"
          "glowing"
          "ash"
          "wink"
        ];
        default = "ash";
        description = ''
          The coals the fire leaves in its corner while it is away: coals that keep glowing, that
          cool to grey ash, or that go dark one by one.
        '';
      };

      cooling = mkOption {
        type = types.numbers.positive;
        default = 60;
        description = "Seconds by which coals cooling to ash or winking out are out.";
      };

      smoke = mkOption {
        type = types.numbers.between 0 1;
        default = 0.4;
        description = "How much smoke rises from the corner when the fire leaves it, thicker and longer with more; 0 for none.";
      };

      sparks = mkOption {
        type = types.numbers.between 0 2;
        default = 0.6;
        description = "Sparks thrown up from the corner when the fire leaves it, per cell of the corner's width; 0 for none.";
      };

      warmth = mkOption {
        type = types.enum [
          "none"
          "fading"
          "lasting"
        ];
        default = "fading";
        description = "Whether the corner's fill stays warm once the fire leaves: dimming over five seconds, or keeping a faint warmth.";
      };

      pilot = mkOption {
        type = types.bool;
        default = false;
        description = "Whether a small blue pilot flame burns in the corner while the fire is away.";
      };

      ash = mkOption {
        type = types.bool;
        default = false;
        description = "Whether a bed of grey ash lies in the corner wherever no coal is.";
      };

      burn = mkOption {
        type = types.enum [
          "living"
          "steady"
        ];
        default = "living";
        description = ''
          How the fire burns at rest in its corner: `living` moves through a fireplace's evening
          (catching, roaring, burning steadily, settling, down to embers, a log going on); `steady`
          holds one low smoulder.
        '';
      };
    };

    footer = {
      separator = mkOption {
        type = types.enum [
          "none"
          "slant"
          "backslant"
          "arrow"
          "gap"
        ];
        default = "arrow";
        description = ''
          Where the footer's bands meet: at a hard edge, through a slant, a backslant, or an arrow
          from Nerd Fonts, or across a cell of the bar. Plain glyphs draw every one as `none`.
        '';
      };

      palette = mkOption {
        type = types.enum [
          "ember"
          "embersoft"
          "emberwhisper"
          "emberdeep"
          "emberseams"
          "embertext"
          "emberwash"
          "smoulder"
          "orangemodel"
          "rustmodel"
          "rust"
          "rustcore"
          "ruststeps"
          "burnt"
          "orange"
          "orangehard"
          "rustorange"
          "tangerine"
          "orangesteps"
          "allorange"
          "borange"
          "blaze"
          "creamrust"
          "apricot"
          "peach"
        ];
        default = "ember";
        description = ''
          The footer's colours, from gruvbox: neutral bands lit in orange (`ember` and its
          variants, `smoulder`), orange bands (`orange`, `rust`, and their steps), or pastel
          orange (`creamrust`, `apricot`, `peach`).
        '';
      };

      hearth = mkOption {
        type = types.ints.between 3 16;
        default = 8;
        description = "Cells of the hearth the fire burns in at the footer's end, narrowing when the footer runs short of room.";
      };
    };

    firelight = {
      reach = mkOption {
        type = types.enum [
          "off"
          "close"
          "room"
          "wide"
        ];
        default = "close";
        description = "How far the fire's light carries across the screen around it. `off` lights nothing.";
      };

      strength = mkOption {
        type = types.enum [
          "faint"
          "warm"
          "bright"
        ];
        default = "warm";
        description = "How brightly the fire lights the screen around it.";
      };

      on = mkOption {
        type = types.enum [
          "everything"
          "fills"
          "text"
          "light"
        ];
        default = "text";
        description = ''
          What answers the fire's light: text and fills, fills alone, or text alone. `light` shows
          the light alone, as each lit cell's fill.
        '';
      };

      haze = mkOption {
        type = types.enum [
          "none"
          "soft"
          "smoky"
        ];
        default = "soft";
        description = "How much of the fire's light the air scatters, lighting even black cells.";
      };
    };

    editor = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "nvim -u NONE";
      description = ''
        The command ctrl+g opens the draft in, with the file path appended. `null` uses
        `$VISUAL`, then `$EDITOR`, then `vi`.
      '';
    };

    logFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/tmp/pituitary.log";
      description = "Where pi's stderr and pituitary's own diagnostics go. `null` discards them.";
    };

    profileFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/tmp/pituitary.profile";
      description = "Where startup and teardown timing marks go. `null` records none.";
    };

    keybindings = mkOption {
      type = types.attrsOf (types.either types.str (types.listOf types.str));
      default = { };
      example = {
        "app.model.select" = "alt+m";
        "app.message.followUp" = [
          "alt+enter"
          "ctrl+enter"
        ];
      };
      description = ''
        Keys for pituitary's actions, named as pi names its keybinding actions. Each entry
        replaces that action's keys from pi's own `keybindings.json`, which stays pi's to manage.
      '';
    };

    extraEnvironment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        PI_CODING_AGENT_SESSION_DIR = "/home/me/pi-sessions";
      };
      description = "Further variables set for pituitary and the pi it starts.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ wrapped ];
    xdg.configFile."pituitary/keybindings.json" = lib.mkIf (cfg.keybindings != { }) {
      text = builtins.toJSON cfg.keybindings;
    };
  };
}
