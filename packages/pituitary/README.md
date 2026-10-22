# pituitary

A terminal workspace for the [pi coding agent](https://github.com/earendil-works/pi), built
with [OpenTUI](https://github.com/sst/opentui). Ordinary conversations use Pi's JSONL RPC
interface; managed local runs use a persistent native SDK worker. Pituitary is maintained
as a package in Realm.

The detailed [orchestration plan](docs/orchestration.md) describes the progression toward
declared NixOS agents, Bay-backed delegation, durable collaboration, and verified results.

## Environment

Realm's root `flake.lock` pins the tools; this package's `bun.lock` pins its JavaScript
dependencies. Node modules, package caches, pi sessions, and test artifacts stay inside this
package directory.

The package and development shell support `x86_64-linux`, `aarch64-linux`, and
`aarch64-darwin`. Intel macOS was removed from nixpkgs unstable in 26.11.

Pituitary detects terminal capabilities rather than requiring a particular emulator.
Tests normally isolate the terminal identity. Separate integration tests check complete
redraws directly and through a real tmux server using Ghostty and Alacritty terminal
types. These inspect the outer protocol stream, rather than launching GUI emulators.
Realm explicitly enables Alacritty's synchronized-output capability in tmux, whose
automatic detection otherwise misses it.

The tracked OpenTUI patch in `patches/` keeps Markdown visible while syntax highlighting
is pending, keeps wrapped measurement and drawing at the same width, and prevents
disabled scrollbars from displacing the first frame. Native first-frame and resize tests
cover these fixes; retain the patch on dependency updates until those tests pass without it.

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
pass/fail table with elapsed times and log links, the tail of the first failing log, and the rendered screen of every UI state the
e2e suite visited.

| gate | what it covers |
| --- | --- |
| `just typecheck` | the whole tree against pi's own published types |
| `just lint` | Biome lint, format, and import order |
| `just unit` | protocol framing, state, native rendering, editor behavior, and development commands |
| `just e2e` | the UI in a headless PTY through [tui-test](https://github.com/microsoft/tui-test) |
| `just perf` | input latency, streaming, startup, and teardown budgets |
| `just package` | the Realm package and its pinned production dependencies |
| `just module` | every Home Manager option, configured wrapper, and keybindings |

Ways to look at the UI:

```sh
just screens                       # every captured screen as text
just tui start --scenario tool     # a live session to operate: just tui submit, key, screen --style
just tui help                      # all driver commands and options
just run tool 40                   # the UI in this terminal against a scripted agent
just live                          # the UI against the real pi CLI
```

`artifacts/screens/` holds a `.txt`, `.svg`, and `.png` per state.
The driver accepts literal leading dashes after `--`, for example `just tui type -- --help`.
Use a JSON array for pi arguments containing spaces:
`just tui start --pi '["--no-session", "-e", "/path with spaces/extension.ts"]'`.
`just demo --help` lists the recording scenes without building their tools; recordings use
Realm's pinned nixpkgs and isolate terminal identity just as the tests do.

### Iterating without a system rebuild

`just live` and `just run` execute the checkout's TypeScript directly. After editing source,
quit and rerun the command to load the changes; no package or system rebuild is needed.
Use `just live --continue` to resume the latest saved session, or
`just live --session /path/to/session.jsonl` to select one explicitly. `just run tool` uses the
scripted agent, so layout experiments need no provider credentials or model calls.

The dev shell puts sessions in this package's `.pi/sessions` and uses the workspace's pi
dependency. To try the source UI with your installed pi and its usual session directory,
run this from the project you want pi to work on, inside the dev shell:

```sh
env -u PI_CODING_AGENT_SESSION_DIR PI_AGENT_CMD=/absolute/path/to/installed/pi \
  bun /absolute/path/to/realm/packages/pituitary/packages/tui/src/main.tsx --continue
```

Source launches read the UI's environment variables and normal keybindings file. Settings
from Home Manager's installed wrapper are not automatically applied to them.

`/reload` reloads pi's extensions, skills, prompts, themes, and context files; it does not
reload Pituitary's UI source. Bun's bare `--watch` and `--hot` are not supported development
launchers: a watch restart can interrupt the asynchronous agent and bridge cleanup, while
hot mode reexecutes startup code that owns the renderer and child processes. Automatic
reloading needs explicit cleanup and session handling first.

## Layout

| path | contents |
| --- | --- |
| `packages/rpc` | JSONL framing, the RPC transport, the event reducer, and scripted event builders |
| `packages/harness` | durable run/task engine, host runtime, native workers, Bay execution, and managed CLI |
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
An explicit `--mode text|json|rpc`, like `--print`, `--help`, or `--version`, runs pi directly.

### Managed runs

Managed commands use one persistent host runtime. The NixOS module starts it as the
configured operator. CLI commands start it when needed; for source development, you can
also run it in the foreground in another terminal:

```sh
just harness serve
```

```sh
pituitary run --name review                    # opens a persistent native conversation
pituitary run --name audit --detach 'Review this project'
pituitary runs
pituitary attach audit
pituitary inspect audit --json
pituitary stop audit
```

Closing the managed UI detaches; the worker continues. Attaching again opens the same
conversation. One client controls input while observers can inspect it. `stop` explicitly
shuts down the worker and retains its conversation and run journal. Run names stay reserved so
reconnecting cannot silently target later work with the same name.

Without `--agent`, these are local workers running with the operator's permissions.
The native worker uses existing Pi credentials and model preferences, with controlled resource discovery: ambient
extensions, skills, and prompt templates are disabled for this initial managed mode.
Custom component screens, terminal takeover, and conversation branching remain available
through ordinary Pituitary. `PI_AGENT_CMD` and `PI_AGENT_ARGS_JSON` configure that ordinary
RPC path; managed runs use the pinned SDK.

Declared agents run inside their Bay machines:

```sh
pituitary agents
pituitary run --agent reviewer --repo gshpychka/realm@main --name isolated-review
pituitary recover isolated-review             # reconcile an interrupted launch
pituitary agents --catalog ./agents.json --json
pituitary attach isolated-review --task TASK_ID
```

`--catalog FILE` or `PITUITARY_CATALOG` selects a resolved catalog without evaluating
repository code. A run freezes its role, machine revision, Bay endpoint, and session
identity, and the reachable definitions it can delegate to. Attaching and inspecting use
that saved target. `recover` can reconcile an
interrupted launch and initialize its existing running worker; it never relaunches an
ended session or replaces a missing worker. `stop` records the desired stopped state
before contacting the worker, so a late observation cannot revive it. For Bay runs it
then suspends the identified VM, preserving its workspace. Result export is not yet
implemented; an explicit Bay `end` or `rm` can discard workspace changes that have not
been copied out.

New runs read the selected catalog again, so source role edits take effect without
restarting the runtime or rebuilding an image. Existing runs keep their frozen
definitions. After a child finishes, attaching to its task opens the saved conversation
as a read-only archive; it does not resume the VM or start another model turn.

The host stores runs, tasks, attempts, command receipts, and a concrete effect outbox in
one SQLite database. A coordinator uses `delegate`, `inspect`, `message`, `yield`, and
`submit` tools. Delegation returns after committing the child task; yielding releases the
model loop until a relevant message or report arrives. A child can address `parent` or
another task ID and correlate its answer with `replyTo`. Reports are retained before
the parent is notified and are explicitly unverified. Code artifact export and result
integration remain later milestones.

Role initialization fixes the model, instructions, and tool selection for the worker's
conversation. A read-only role cannot bypass its tool selection through the operator's
`!` shell command. Tool restrictions do not sandbox commands when the role permits Bash.
Named API-key profiles are delivered through the private worker connection and held in
memory by the SDK. Roles name permitted profiles; they cannot supply host paths or key
values. OAuth refresh and a provider broker are not implemented. VM memory checkpoints
can retain in-memory credentials.

`--state DIR` or `PITUITARY_STATE_DIR` selects an isolated run store. Its default is
`$XDG_STATE_HOME/pituitary` or `~/.local/state/pituitary`. Credentials stay outside saved
worker state. `PITUITARY_AUTH_FILE` and `PITUITARY_CONFIG_DIRECTORY` can select explicit
credential and model-preference sources.

From the checkout, `just harness run --name review` and `just harness attach review`
execute source without a system rebuild. The dev shell keeps managed state in `.pi/runs`.
Restarting the frontend or host runtime preserves a live worker. A changed execution
generation or worker incarnation interrupts its attempt; recovery does not substitute a
new conversation or silently replay uncertain work.

### Declaring agent machines

The host module registers agents, their real NixOS machines, and their Bay programs:

```nix
{
  imports = [ realm.nixosModules.pituitary ];
  networking.hostId = "8425e349"; # Bay's ZFS storage needs a host ID
  services.bay.network.address = "10.80.0.1/24";
  services.pituitary = {
    enable = true;
    operator = "alice";
    credentialProfiles.primary = {
      provider = "anthropic";
      file = "/run/secrets/pituitary-api-key";
    };
    limits = { maxTasks = 8; maxLiveAttempts = 2; maxDepth = 1; };
    agents = {
      coordinator = {
        pituitary.agent = {
          instructions = "Delegate one review, answer its questions, and submit a report.";
          model = "anthropic/your-chosen-model";
          delegatesTo = [ "reviewer" ];
          credentials = [ "primary" ];
          limits = { maxChildren = 1; maxDepth = 1; };
        };
      };
      reviewer = { pkgs, ... }: {
        environment.systemPackages = [ pkgs.ripgrep pkgs.go ];
        pituitary.agent = {
          description = "Review a change and its evidence.";
          instructions = "Find concrete defects in the supplied result.";
          model = "anthropic/your-chosen-model";
          tools = [ "read" "grep" ];
          credentials = [ "primary" ];
        };
      };
      builder = {
        imports = [ ./agents/development-machine.nix ];
        pituitary.agent = {
          instructions = "Implement one reviewed result.";
          delegatesTo = [ "reviewer" ];
        };
      };
    };
  };
}
```

Each entry accepts ordinary NixOS imports, packages, and services. The module enables
Bay and the host runtime, installs client defaults and `/etc/pituitary/agents.json`, and
validates delegation and credential references. Credential files must already exist at
runtime and be readable by the operator; their contents never enter the Nix store.
`delegatesTo` grants bounded dispatch authority, and role ceilings intersect with the
run's remaining limits. Declaring an agent does not launch it. Configure Bay storage, networking, and capacity
for the host before enabling the service. This change does not enable Bay on reaper.

Equal machines share an image and, with equal resource allocations, an immutable warm
base. Role instructions, model, tools, and delegation metadata stay in the runtime
catalog; editing them does not rebuild guest images. Host CLI changes also stay outside
the worker package. Machine image/resource revisions are pinned in Bay session records;
updates prepare new bases and retain earlier ones for existing sessions.

For direct composition, `lib.pituitaryAgent` evaluates one machine without registering
or launching it:

```nix
realm.lib.pituitaryAgent {
  name = "reviewer";
  inherit pkgs;
  workerPackage = realm.packages.${pkgs.system}.pituitary-worker;
  modules = [
    ({ pkgs, ... }: {
      environment.systemPackages = [ pkgs.ripgrep pkgs.go ];
      pituitary.agent = {
        description = "Review a change and its evidence.";
        instructions = "Find concrete defects in the supplied result.";
        model = "anthropic/your-chosen-model";
        tools = [ "read" "grep" ];
      };
    })
  ];
}
```

The result exposes `system`, `image`, `manifest`, `manifestFile`, and a Bay `program`
definition with launch/resume/connect commands. The worker package contains no OpenTUI
or frontend tools. Role metadata stays in the separate manifest: changing instructions
or a model preserves the machine image, while changing its packages changes that image.
The host module composes these outputs into the runtime catalog and Bay declarations.

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
    agent.args = [ "--thinking" "high" ];              # one argument per item, spaces preserved
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
    stateDirectory = null;                             # managed runs; null follows XDG state defaults
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
per stretch of work, growing up to a third of the screen high and following the latest step while pi works.
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
`/usage`, `/copy`, `/export`, `/settings`, `/hotkeys`, `/tree`, `/reload`, `/changelog`,
`/share`, `/scoped-models`, `/import`, `/trust`, `/debug`, and `/quit` run here; every other
`/command` goes to pi, so extension commands, prompt templates, and skills work as they do in pi.
`/` and `@` complete command names and file paths.

The extension bridge runs tree navigation and resource reloading inside pi; `/share` uses
GitHub CLI to create a secret gist. `/login` and `/logout` hand the terminal to pi on the same
session, then restore the frontend when pi exits.

## Talking to pi

The UI spawns `pi --mode rpc` and reads line-delimited JSON from its stdout. `PI_AGENT_CMD` and
`PI_AGENT_ARGS_JSON` redirect that to any process speaking the same protocol. The latter is a
JSON array of strings, preserving spaces and empty arguments. Legacy `PI_AGENT_ARGS` accepts
whitespace-separated words when the JSON variable is unset.

Scripted agents are selected with `FAKE_PI_SCENARIO`; `FAKE_PI_DELAY_MS` spaces their events out
so intermediate states are observable. Scenarios live in `packages/fake-pi/scenarios`.

The former [`gshpychka/pituitary`](https://github.com/gshpychka/pituitary) repository is retired.
Its source was imported at `a0ebe85eccfe7192ae80b91f7c8ca16898d9aeaf`, with the local
`margins` branch's `3b07d36` continuation alignment adapted to the current layout.
