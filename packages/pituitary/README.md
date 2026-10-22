# pituitary

An [OpenTUI](https://github.com/sst/opentui) frontend for the
[pi coding agent](https://github.com/earendil-works/pi), driven over pi's JSONL RPC protocol, and
the environment it is built in. Pituitary is maintained here as a Realm package; the former
[`gshpychka/pituitary`](https://github.com/gshpychka/pituitary) repository is retired.
Imported from commit `a0ebe85eccfe7192ae80b91f7c8ca16898d9aeaf` with its Bun workspaces intact.
The local `margins` branch's `3b07d36` improvement is adapted to the current Work/Reply layout:
reply, custom, summary, notice, and shell-output continuations align beyond their marks, with
the current glyphs and text selection preserved. Narrow terminals and resizing have regression
coverage.

## Environment

Realm's root `flake.lock` pins the tools; this package's `bun.lock` pins its JavaScript
dependencies. Node modules, package caches, pi sessions, and test artifacts stay inside this
package directory.

The package and development shell support `x86_64-linux`, `aarch64-linux`, and
`aarch64-darwin`. Intel macOS was removed from nixpkgs unstable in 26.11.

```sh
cd packages/pituitary             # from the Realm checkout
nix develop ../..#pituitary
bun install
just loop
```

The shell provides bun (the UI runtime), Node 22 (the test runner), TypeScript, Biome, and just.
`pi` itself is a project dependency, on `PATH` through `node_modules/.bin`.

## The loop

`just loop` runs every gate, continues past failures, and writes `artifacts/report.md`: a
pass/fail table, the tail of the first failing log, and the rendered screen of every UI state the
e2e suite visited.

| gate | what it covers |
| --- | --- |
| `just typecheck` | the whole tree against pi's own published types |
| `just lint` | Biome lint, format, and import order |
| `just unit` | protocol framing, the event reducer, and paced rendering |
| `just e2e` | the UI in a headless PTY through [tui-test](https://github.com/microsoft/tui-test) |
| `just package` | the Realm package and its pinned production dependencies |
| `just module` | every Home Manager option, configured wrapper, and keybindings |

Ways to look at the UI:

```sh
just screens                       # every captured screen as text
just tui start --scenario tool     # a live session to operate: just tui submit, key, screen --style
just run tool 40                   # the UI in this terminal against a scripted agent
just live                          # the UI against the real pi CLI
```

`artifacts/screens/` holds a `.txt`, `.svg`, and `.png` per state.

## Layout

| path | contents |
| --- | --- |
| `packages/rpc` | JSONL framing, the RPC transport, the event reducer, and scripted event builders |
| `packages/fake-pi` | an RPC agent with scripted replies, used by every test |
| `packages/tui` | the OpenTUI React frontend |
| `packages/spatial` | panes on a lattice, walked between and zoomed out over |
| `packages/ember` | fire drawn in block characters: tiles, rows, and columns |
| `e2e` | tui-test specs and the PTY harness |
| `scripts/loop.sh` | the iteration driver behind `just loop` |

## Daily use

Realm's flake builds `pituitary`:

```sh
nix run /path/to/realm#pituitary -- --continue     # any pi argument passes through
```

`pituitary` drives the `pi` on `PATH` with your own settings, extensions, and sessions.

### Home Manager

Realm exports `homeManagerModules.pituitary`. Its settings travel in the installed `pituitary` wrapper,
so they reach pituitary and the pi it starts, and no other program.

```nix
{
  inputs.realm = {
    url = "github:gshpychka/realm";
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.home-manager.follows = "home-manager";
  };

  # in the home configuration's modules:
  imports = [ inputs.realm.homeManagerModules.pituitary ];

  programs.pituitary = {
    enable = true;
    agent.command = "pi";                              # the pi executable, on PATH or absolute
    agent.args = [ "--thinking" "high" ];              # one word each, ahead of pituitary's own
    glyphs = "nerd-font";                              # or "plain" without a Nerd Font
    animations = true;                                 # false holds the fire on one frame
    fire.travels = true;                               # false keeps the fire in its corner while pi works
    fire.coals = "ash";                                # what it leaves there: none, glowing, ash, wink
    fire.cooling = 60;                                 # seconds for coals to go out
    fire.smoke = 0.4;                                  # 0..1, 0 for none
    fire.sparks = 0.6;                                 # per cell of the corner, 0..2
    fire.warmth = "fading";                            # none, fading, lasting
    fire.pilot = false;                                # a small blue pilot flame
    fire.ash = false;                                  # a bed of grey ash where no coal is
    fire.burn = "living";                              # or steady, one low smoulder
    footer.separator = "arrow";                        # none, slant, backslant, arrow, gap
    footer.palette = "ember";                          # the footer's colours, listed below
    footer.hearth = 8;                                 # cells the fire burns in, 3..16
    firelight.reach = "close";                         # how far the fire lights: off, close, room, wide
    firelight.strength = "warm";                       # faint, warm, bright
    firelight.on = "text";                             # everything, fills, or light, which shows the light alone
    firelight.haze = "soft";                           # none, soft, smoky
    editor = "nvim";                                   # what ctrl+g opens; null uses $VISUAL, $EDITOR, vi
    logFile = "/tmp/pituitary.log";                       # pi's stderr and diagnostics; null discards them
    profileFile = null;                                # startup and teardown timing marks
    nvimPackage = null;                                # the draft's neovim; null keeps the pinned build
    ghPackage = null;                                  # gh for the pull request and /share; null keeps the pinned build
    keybindings."app.model.select" = "alt+m";          # layered over pi's keybindings.json
    extraEnvironment = { };                            # further variables for pituitary and pi
  };
}
```

`keybindings` writes `~/.config/pituitary/keybindings.json`. Each entry replaces that action's keys
from pi's own `keybindings.json`, which stays pi's to manage.

The package pins its installed dependencies by hash. When `bun.lock` changes, `just loop` fails
at the `package` gate; set `outputHash` in `default.nix` to `lib.fakeHash`, run
`nix build ../..#pituitary`, and copy the hash it reports.

## Using it

The screen is the conversation, a line saying what pi is doing, the editor, and a footer in bands
from each edge inward. On the left sit the working directory, then the git branch and session
name; on the right the fire's hearth, then the model beside its provider's icon in the provider's
brand colour with its thinking level, then the context percentage and a card holding the cost and
usage limits. A click on the card opens and closes it. `PITUITARY_FOOTER_SEPARATOR` sets where
bands meet (`none`, `slant`, `backslant`, `arrow`, or `gap`, a cell of the bar; `arrow` by default,
and `none` under plain glyphs), `PITUITARY_FOOTER_PALETTE` their colours (`ember`, `embersoft`,
`emberwhisper`, `emberdeep`, `emberseams`, `embertext`, `emberwash`, `smoulder`, `orangemodel`,
`rustmodel`, `rust`, `rustcore`, `ruststeps`, `burnt`, `orange`, `orangehard`, `rustorange`,
`tangerine`, `orangesteps`, `allorange`, `borange`, `blaze`, `creamrust`, `apricot`, `peach`;
`ember` by default), and `PITUITARY_FOOTER_HEARTH` the hearth's width in cells (3..16, 8 by
default); an unknown value takes the default. Short of room, the footer drops the session name,
then the thinking level, then takes two rows, then narrows the hearth.
When the branch has a GitHub pull request, its number sits beside the branch, coloured by its
state and linked to it in a terminal that draws links. pituitary asks the GitHub CLI under your own
login (`PITUITARY_GH`, pinned by the package), as `/share` does to publish a secret gist; set it
empty and pituitary runs no gh, leaving both off.
Extension statuses sit in the footer as Nerd Fonts icons, quiet while healthy and otherwise in the
colour of their state beside their words;
`PITUITARY_PLAIN_GLYPHS=1` swaps these and every other icon for plain Unicode. Token counts are in
`/session`.
On a Claude subscription the card holds each usage-limit window and extra usage while it runs,
turns yellow past 70% and red past 90%, and opens on its own past 80%; `/usage` lists them in
full. One fire keeps pituitary company: it smoulders in the footer's hearth while pi is idle, when
the footer has room, and travels to the working line, flaring up, while pi works.
`PITUITARY_STILL=1` holds it still. At rest it moves through a fireplace's evening (catching,
roaring, burning steadily, settling, down to embers, a log going on); `PITUITARY_FIRE_BURN=steady`
holds it at one low smoulder.
It lights the screen around it: `PITUITARY_FIRELIGHT` sets how far (`off`, `close`, `room`,
`wide`), `PITUITARY_FIRELIGHT_STRENGTH` how brightly (`faint`, `warm`, `bright`),
`PITUITARY_FIRELIGHT_ON` what answers it (`everything`, `fills`, `text`, or `light`, which shows
the light alone), and `PITUITARY_FIRELIGHT_HAZE` how much the air scatters (`none`, `soft`,
`smoky`). They default to `close`, `warm`, `text`, and `soft`, as does an unknown value.
`PITUITARY_FIRE_TRAVELS=off` keeps the fire in its corner while pi works. While it is away the
corner keeps what it left, lit the same way until it returns:
`PITUITARY_FIRE_COALS` (`none`, `glowing`, `ash` cooling to grey, `wink` going dark one by one;
`ash` by default) that go out over `PITUITARY_FIRE_COOLING` seconds (60), `PITUITARY_FIRE_SMOKE`
(0..1, 0.4), `PITUITARY_FIRE_SPARKS` per cell of the corner (0..2, 0.6), `PITUITARY_FIRE_WARMTH`
in its fill (`none`, `fading`, `lasting`; `fading`), a blue pilot flame
(`PITUITARY_FIRE_PILOT=on`), and a bed of ash (`PITUITARY_FIRE_ASH=on`). An unknown value takes
the default.
Extension dialogs and widgets appear where pi's own interface puts them.

The model's thinking, the words it writes on its way, and its tool calls sit in one rounded box
per stretch of work, a third of the screen high, which follows the latest step while pi works.
Once the reply after it ends, the box folds to one line saying what it came to, such as
`thought · 6 tools · 1 failed`. A click on that line opens or closes the box; the wheel scrolls an
open box, then the conversation once the box reaches its end. ctrl+o opens every box at full
length, and ctrl+f steps through them from the keyboard.

The editor is an embedded nvim (`nvim --embed --clean`) that draws the draft itself, so motions,
text objects, registers, counts, `.`, undo, and wrapping are nvim's own: a long line wraps between
words and scrolls a row at a time. It starts in insert mode, one row high, and grows to eight as the
draft does; the tag beside it reads N in normal mode, V in visual, and the steering mark while pi works,
all one cell so the draft never moves across. The package runs a pinned
nvim; `PITUITARY_NVIM` points elsewhere, and without nvim a plain editor takes over.

| key | |
| --- | --- |
| enter · shift+enter, ctrl+j | send, from insert or normal mode · new line |
| `!cmd` · `!!cmd` | run a shell command, kept in or out of the model's context |
| alt+enter | queue a follow-up while pi works; enter queues a steering message |
| esc | leave insert mode; in normal mode, interrupt and send queued messages as the next prompt, steering first, or cancel a command or retry; close a dialog or picker |
| up · down | move a screen row; at the top, up twice takes queued messages back into the editor, then earlier prompts, and up goes on stepping back · later prompts, at the bottom |
| ctrl+l · ctrl+p · shift+tab | pick a model · next model · next thinking level |
| ctrl+o · ctrl+t | open every box of work at full length · show or hide thinking |
| ctrl+f | step through the boxes of work: up · down pick one, enter opens it, j · k scroll it, esc returns to the editor |
| ctrl+g | edit the draft in `$VISUAL` |
| pgup · pgdn | scroll |
| ctrl+c · ctrl+c twice, ctrl+d | clear the draft · quit |

Bindings follow pi's action names, and `~/.pi/agent/keybindings.json` overrides them as it does
for pi; ctrl+f is pituitary's own `app.tools.browse`.

`/model`, `/thinking`, `/new`, `/resume`, `/fork`, `/clone`, `/compact`, `/name`, `/session`,
`/usage`, `/copy`, `/export`, `/settings`, `/hotkeys`, and `/quit` run here; every other
`/command` goes to pi, so extension commands, prompt templates, and skills work as they do in pi.
`/` and `@` complete command names and file paths.

Moving along the session tree, sharing, signing in, and reloading have no RPC command; the
frontend says so and `pi` itself covers them.

## Talking to pi

The UI spawns `pi --mode rpc` and reads line-delimited JSON from its stdout. `PI_AGENT_CMD` and
`PI_AGENT_ARGS` redirect that to any process speaking the same protocol, which is how the tests
substitute the scripted agent.

Scripted agents are selected with `FAKE_PI_SCENARIO`; `FAKE_PI_DELAY_MS` spaces their events out
so intermediate states are observable. Scenarios live in `packages/fake-pi/scenarios`.
