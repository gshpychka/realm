# Builds a home configuration with every option set and checks that the installed wrapper
# and the generated keybindings carry what the options say.
{
  pkgs,
  home-manager,
  module ? import ../modules/home-manager/pituitary.nix,
}:
let
  agent = pkgs.writeShellScript "pituitary-check-agent" ''
    exec ${pkgs.jq}/bin/jq -cn --args '$ARGS.positional' -- "$@"
  '';
  home = home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      module
      {
        home = {
          username = "check";
          homeDirectory = "/home/check";
          stateVersion = "25.05";
        };
        programs.pituitary = {
          enable = true;
          stateDirectory = "/home/check/.local/state/pituitary-runs";
          nvimPackage = pkgs.neovim-unwrapped;
          ghPackage = pkgs.gh;
          agent = {
            command = toString agent;
            args = [
              "--no-extensions"
              "--thinking"
              "high"
              "--session-dir"
              "/some directory/pi sessions"
              "--name"
              "the 'quoted' session"
              ""
            ];
          };
          glyphs = "plain";
          animations = false;
          fire = {
            travels = false;
            coals = "wink";
            cooling = 30;
            smoke = 0.5;
            sparks = 1.5;
            warmth = "lasting";
            pilot = true;
            ash = true;
            burn = "steady";
          };
          footer = {
            separator = "backslant";
            palette = "peach";
            hearth = 12;
          };
          firelight = {
            reach = "wide";
            strength = "bright";
            on = "fills";
            haze = "smoky";
          };
          editor = "nvim -u NONE";
          logFile = "/tmp/pituitary.log";
          profileFile = "/tmp/pituitary.profile";
          keybindings = {
            "app.model.select" = "alt+m";
            "app.message.followUp" = [
              "alt+enter"
              "ctrl+enter"
            ];
          };
          extraEnvironment.PITUITARY_CHECK = "set";
        };
      }
    ];
  };
  inherit (home) config;
in
pkgs.runCommand "pituitary-home-manager-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
  wrapper=${config.home.path}/bin/pituitary
  test -x "$wrapper"

  expect() {
    grep -qF -- "$1" "$wrapper" || { echo "wrapper lacks: $1"; cat "$wrapper"; exit 1; }
  }
  expect "PI_AGENT_CMD='${agent}'"
  expect "PI_AGENT_ARGS_JSON="
  expect "PITUITARY_NVIM='${pkgs.neovim-unwrapped}/bin/nvim'"
  expect "PITUITARY_GH='${pkgs.gh}/bin/gh'"
  expect "PITUITARY_PLAIN_GLYPHS='1'"
  expect "PITUITARY_STILL='1'"
  expect "PITUITARY_FIRELIGHT='wide'"
  expect "PITUITARY_FIRELIGHT_STRENGTH='bright'"
  expect "PITUITARY_FIRELIGHT_ON='fills'"
  expect "PITUITARY_FIRELIGHT_HAZE='smoky'"
  expect "PITUITARY_FIRE_TRAVELS='off'"
  expect "PITUITARY_FIRE_COALS='wink'"
  expect "PITUITARY_FIRE_COOLING='30'"
  expect "PITUITARY_FIRE_SMOKE='0.500000'"
  expect "PITUITARY_FIRE_SPARKS='1.500000'"
  expect "PITUITARY_FIRE_WARMTH='lasting'"
  expect "PITUITARY_FIRE_PILOT='on'"
  expect "PITUITARY_FIRE_ASH='on'"
  expect "PITUITARY_FIRE_BURN='steady'"
  expect "PITUITARY_FOOTER_SEPARATOR='backslant'"
  expect "PITUITARY_FOOTER_PALETTE='peach'"
  expect "PITUITARY_FOOTER_HEARTH='12'"
  expect "PITUITARY_EDITOR='nvim -u NONE'"
  expect "PITUITARY_LOG='/tmp/pituitary.log'"
  expect "PITUITARY_PROFILE='/tmp/pituitary.profile'"
  expect "PITUITARY_KEYBINDINGS='/home/check/.config/pituitary/keybindings.json'"
  expect "PITUITARY_CHECK='set'"
  expect "PITUITARY_STATE_DIR='/home/check/.local/state/pituitary-runs'"

  # Exercise the installed wrapper and argument decoder together: shell quoting,
  # embedded spaces, and an empty argument must survive both layers.
  test "$("$wrapper" --version | jq -c .)" = ${
    pkgs.lib.escapeShellArg (builtins.toJSON (config.programs.pituitary.agent.args ++ [ "--version" ]))
  }

  bindings=${config.home-files}/.config/pituitary/keybindings.json
  test "$(jq -r '."app.model.select"' "$bindings")" = "alt+m"
  test "$(jq -c '."app.message.followUp"' "$bindings")" = '["alt+enter","ctrl+enter"]'

  touch $out
''
