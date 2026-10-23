# Pituitary

**One conversation to work in. A declared team when you need one.**

Read a project, edit code, run commands, and keep working across terminal disconnects.
Give a declared team an objective to work in isolated NixOS machines, exchange
results, and produce code with independent verification.

[Start a conversation](#start-a-conversation) · [Try the UI](#try-it-without-credentials) ·
[Run a team](#give-a-team-an-objective) · [Declare agents](../../agents) · [Bay](../bay)

![Pituitary rendering a tool call, its output, and a queued steering message](docs/images/conversation.png)

*Terminal capture from a deterministic test scenario; no provider request.*

## Choose your starting point

| You want to… | Start with | Where code changes |
| --- | --- | --- |
| Work interactively in a project | `pituitary` | Directly in your current directory |
| See the interface without credentials | `just run tool` in the dev shell | No project edits; scripted output |
| Give a team an objective | `pituitary run --agent coordinator --workspace "$PWD" '…'` | Isolated checkouts; your checkout changes when you apply |
| Run a terminal program in a VM | [Bay's quickstart](../bay#try-a-session) | The session's own disk |

Local conversations work on Linux and macOS without Bay. Declared teams need a
configured NixOS host with Bay; their terminal can also connect over SSH.

## Start a conversation

From a Realm checkout, with provider credentials available to the host runtime:

```sh
nix run .#pituitary
```

Choose a model with `/model` or `ctrl+l`, then ask about the project. The agent has
file reading, editing, writing, search, and shell tools. It works as your user in
the current directory.

For example, if your Anthropic API key lives in a private file, set it **before
the runtime first starts**:

```sh
export ANTHROPIC_API_KEY="$(cat /path/to/your/api-key)"
nix run .#pituitary
```

Replace that file path with your own. Other providers use their supported
credential environment variables. On a managed host, use declared
[credential profiles](../../agents#connect-the-team-to-a-host) instead.

With Pituitary installed through [Home Manager](#make-it-yours), start a named
conversation from any project:

```sh
cd /path/to/project
pituitary run --name explore 'Explain how this project fits together'
```

Send with `enter`; use `shift+enter` or `ctrl+j` for a newline. `alt+enter` queues a
follow-up during a turn. Detach with `ctrl+d`, or press `ctrl+c` twice. Work stays
in the host runtime:

```sh
pituitary runs
pituitary attach explore
```

Without an installed command, use `nix run /path/to/realm#pituitary -- …` from your
project. The path selects Realm's package; the current directory is your workspace.
An explicit `--model provider/model` selects an available model without the picker.

## Try it without credentials

From the Realm root:

```sh
nix develop .#pituitary
cd packages/pituitary
bun install
just run tool
```

This opens the real interface on a native Pi Durable conversation with a scripted
Faux model. Type a message to see a tool call and its output. The model makes no
external requests; this scenario prints fixed output without editing project files.
It is an interface demo, not an agent solving your project.

## Give a team an objective

First [declare a team and enable its host runtime](../../agents). The starter team
provides `coordinator`, `builder`, `reviewer`, and a verifier environment. These are
declarations you import, not automatically enabled agents.

On that host, from a Git project with checks matching your team's verification policy:

```sh
pituitary agents
pituitary run --agent coordinator --name feature --workspace "$PWD" \
  'Implement the feature, have it reviewed, and return a verified result'
```

`--workspace` captures tracked working files, including staged and unstaged edits.
Add selected untracked paths with `--include-untracked PATH`. Every writer gets an
isolated checkout; your branch, index, and files stay untouched.

The coordinator delegates work, receives reports, and can ask you questions.
Pituitary retains code as immutable Git bundles, integrates contributions, and runs
declared checks against the exact integrated tree in a fresh verifier machine.

```mermaid
flowchart LR
  Objective[Your objective] --> Team[Declared agents]
  Team --> Code[Retained code]
  Code --> Checks[Fresh verifier]
  Checks --> Result[Verified result]
  Result --> Apply[You apply]
```

Use `ctrl+k` to switch tasks, `alt+left` to return, and `ctrl+q` for questions. Opening
a teammate observes its conversation; `alt+i` explicitly joins its input lease.
Each conversation keeps its draft and viewport.

```sh
pituitary inspect feature
pituitary attach feature
pituitary apply feature
```

`apply` requires current passing verification and a checkout still matching the
captured input. It applies changes without changing your branch or index. Review,
commit, and push through your usual Git workflow. Missing verification policy leaves
code explicitly unverified. A model's claim that tests passed is separate from evidence.

The [agent guide](../../agents#follow-the-work) covers questions, retries, task
revisions, and the result view.

## Know what runs where

| Piece | Responsibility |
| --- | --- |
| Host Pi Durable harness | Models, credentials, conversations, task ownership, and recovery |
| Bay NixOS machines | Agents' files and commands; fresh verification environments |
| Terminal frontend | Presentation, drafts, navigation, and operator input |

Closing or reloading the frontend leaves work running. On a managed NixOS host,
`pituitary.service` owns the runtime; a standalone local launch starts it on demand.
`pituitary stop RUN` cancels owned work and retains conversations and machine
workspaces. `pituitary recover RUN` retries parked workflow phases.

Pituitary uses Pi Durable directly. Stock Pi's extensions, configured prompts,
custom provider definitions, and Claude bridge configuration are not loaded. There
is no built-in Claude Code login flow; declared roles use host API-key profiles.

The [architecture](docs/orchestration.md) explains authority, recovery, and the code
and evidence flow. The [CLI entrypoint](packages/harness/src/main.ts) defines commands.

## Make it yours

Import the [Home Manager module](../../modules/home-manager/pituitary.nix):

```nix
{ inputs, ... }:
{
  imports = [ inputs.realm.homeManagerModules.pituitary ];

  programs.pituitary = {
    enable = true;
    glyphs = "plain"; # or "nerd-font" with a Nerd Font
    animations = true;
    footer.palette = "ember";
    keybindings."app.model.select" = "alt+m";
  };
}
```

Realm already imports the module. `programs.pituitary.model` sets a local default
using an available `provider/model` ID; declared roles keep their own model fixed.
The module also exposes editor, fire, firelight, logging, state-directory, and
remote-socket settings. Its wrapper scopes these preferences to Pituitary.

The editor embeds a clean, pinned Neovim, starts in insert mode, and grows with the
draft. `PITUITARY_NVIM` selects another executable. `PITUITARY_EDITOR`, `$VISUAL`,
and `$EDITOR` select the external editor used by `ctrl+g`.

<details>
<summary>Keys, slash commands, and terminal preferences</summary>

| Key | Action |
| --- | --- |
| enter / shift+enter or ctrl+j | Send / insert a newline |
| alt+enter | Queue a follow-up during a turn |
| esc | Leave insert mode; interrupt from normal mode; close a picker |
| ctrl+l / ctrl+p / shift+tab | Choose model / next model / thinking level |
| ctrl+o / ctrl+t | Expand work / toggle thinking |
| ctrl+f | Browse work boxes |
| ctrl+g | Edit the draft externally |
| pgup / pgdn | Scroll the conversation |
| ctrl+c / ctrl+c twice or ctrl+d | Clear draft / detach |
| ctrl+r | Reload the source frontend |

`/model`, `/thinking`, `/compact`, `/name`, `/session`, `/copy`, `/hotkeys`, and `/quit`
provide conversation controls. `/` completes commands. Local conversations also
complete `@` paths and show the checkout's branch and GitHub pull request. The footer
shows directory, conversation, model, context, and usage. GitHub CLI supplies local
pull-request information; `PITUITARY_GH=""` disables that lookup.

`PITUITARY_PLAIN_GLYPHS=1` selects plain symbols. `PITUITARY_STILL=1` holds animation.
Runtime behavior follows negotiated capabilities. Protocol tests cover Ghostty and
tmux in Ghostty without requiring an emulator identity at runtime.

</details>

## Connect from another machine

Keep the harness, credentials, and Bay environments on the host. First ask the host
for its private socket path:

```sh
ssh host pituitary socket
```

On your frontend machine, use that path as `/remote/runtime/socket` below:

```sh
ssh -NT -L "$HOME/.pituitary-remote.sock:/remote/runtime/socket" host
```

Leave the tunnel running. In another terminal:

```sh
pituitary attach feature --socket "$HOME/.pituitary-remote.sock"
```

`PITUITARY_RUNTIME_SOCKET` or Home Manager's `runtimeSocket` can make it the default.
New remote solo runs require `--cwd` with a host directory. Start team workspace
captures on the host: the workspace path belongs to the host, not the frontend.

## Develop without rebuilding the system

From the Realm root:

```sh
nix develop .#pituitary
cd packages/pituitary
bun install
just live --watch
```

Configure provider credentials before starting the source runtime. `--watch`
restarts only the frontend after a UI source change; `ctrl+r` and `/reload-ui`
request the same orderly restart. Drafts and viewports survive; host work keeps
running. Use `just harness attach RUN --watch` for an existing source run.

| Change | What needs to reload |
| --- | --- |
| Terminal UI source | Frontend only; use `--watch` |
| Host application source | Restart the host runtime; tasks resume from checkpoints |
| Instructions, models, tools, or checks | Regenerate the catalog; new runs use it |
| Machine packages or services | Rebuild the affected image |

The dev shell keeps caches and host state inside the checkout. Installed wrapper
preferences are not implicitly copied into source launches. `PITUITARY_STATE_DIR`
selects private host state; source runs use their own state directory by default.

| Path | Responsibility |
| --- | --- |
| [`packages/harness`](packages/harness) | Workflows, domain tools, Bay adapter, artifacts, host API, CLI |
| [`packages/session`](packages/session) | Presentation events, state reduction, and pacing |
| [`packages/tui`](packages/tui) | Editor, transcript, team navigation, and renderer |
| [`packages/ember`](packages/ember) | Fire and light primitives |
| [`e2e`](e2e) | Provider-free terminal scenarios and performance evidence |

<details>
<summary>Validation and packaging</summary>

Validation is batched at major milestones. `just loop` runs typechecking, formatting,
unit tests, PTY scenarios, latency budgets, package, and Home Manager gates. It writes
`artifacts/report.md`, logs, and captured screens; inspect the `.txt` and `.png` files.
`just tui` drives a native test conversation interactively. Bay's real VM checks live
in Realm's flake tests. New source files must be tracked for Git-backed flake builds.

`bun.lock` pins dependencies. To renew the production dependency hash after changing
it, set `outputHash` in `default.nix` to `lib.fakeHash`, build `../..#pituitary`, and
use the reported hash.

</details>

The former [Pituitary repository](https://github.com/gshpychka/pituitary) is retired.
Source, packages, modules, and issues belong in Realm.
