# Pituitary

A durable agent workspace with a terminal interface. One host Pi Durable harness owns
conversations and recovery. Agents use declared Bay NixOS machines for files and
commands; model calls and credentials stay on the host. Pituitary turns an objective
into delegated work, retained code, and a result with independent evidence.

The [architecture](docs/orchestration.md) describes the domain, authority, execution,
and artifact flow in detail.

## Using it

```sh
pituitary                              # a local durable conversation; choose a model
pituitary --model provider/model 'Investigate this project'
pituitary agents                       # available declared roles
pituitary run --agent coordinator --name feature --workspace "$PWD" 'Build the feature'
pituitary runs
pituitary inspect feature
pituitary attach feature
pituitary apply feature                 # explicitly apply the current verified result
```

Provider credentials are configured on the host. A local conversation can choose an
available model; a declared role freezes its model and capabilities for the run.
`--repo OWNER/NAME@REF` adds read-only repository context to a declared run.

`--workspace` captures tracked working files, including staged and unstaged edits,
without changing the operator's branch or index. Add selected untracked paths with
`--include-untracked PATH`. Every writer receives an isolated checkout. Results are
retained as immutable Git bundles, integrated against an exact base, and checked in
a fresh declared verifier machine. Missing verification policy leaves code explicitly
unverified. Apply checks the original checkout's provenance and preserves its index.

Closing the terminal detaches the frontend. `pituitary stop RUN` cancels owned work
and retains its conversations and machine workspaces. `pituitary recover RUN` retries
parked native workflow phases using their saved identities and receipts. Inspect
explains failures and waiting reasons; it never creates a replacement machine merely
because the outcome of a launch is uncertain.

The main view is one conversation. A task sidebar on wide screens and compact cards
on narrow screens show delegated work and result evidence. `ctrl+k` switches tasks,
`alt+left` returns, and `ctrl+q` opens questions needing attention. Each conversation
keeps its draft and viewport. Opening a teammate observes it; `alt+i` explicitly joins
its input lease. Results distinguish reports, retained code, merge conflicts,
checks, and accepted code.

```sh
pituitary answer QUESTION 'The answer'
pituitary retry TASK --revision 2
pituitary revise TASK --revision 2 --accept 'Required behavior' 'Refined objective'
pituitary integrate TASK --revision 2
pituitary attach RUN --task TASK
```

Task commands name the current revision. Revising upstream work invalidates dependent
results and rebuilds integration from valid contributions.

## Declare agents

Each entry in `services.pituitary.agents` is an ordinary NixOS module. Role metadata
lives beside its environment declaration and stays outside the machine image.

```nix
services.pituitary = {
  enable = true;
  operator = "alice";
  credentialProfiles.primary = {
    provider = "anthropic";
    file = "/run/secrets/agent-api-key";
  };
  agents = {
    coordinator.pituitary.agent = {
      instructions = builtins.readFile ./agents/coordinator.md;
      model = "anthropic/your-model";
      credentials = [ "primary" ];
      delegatesTo = [ "builder" ];
    };
    builder = { pkgs, ... }: {
      imports = [ ./agents/development-machine.nix ];
      environment.systemPackages = [ pkgs.bun ];
      pituitary.agent = {
        instructions = builtins.readFile ./agents/builder.md;
        model = "anthropic/your-model";
        credentials = [ "primary" ];
        verification = {
          agent = "verifier";
          checks.unit.command = [ "bun" "test" ];
        };
      };
    };
    verifier = { pkgs, ... }: {
      environment.systemPackages = [ pkgs.bun ];
    };
  };
};
```

The module declares Bay programs and images, installs the resolved role catalog, and
starts one host runtime as the operator. Declaring a role does not launch an instance.
Equal images share a warm base. Editing prompts, models, allowed tools, or verification
commands does not rebuild the image; changing system dependencies does.

Credential profiles reference runtime files. Secrets never enter the Nix store or a
guest. The host validates each role's credential grants before starting its work.
`limits` bounds tasks, live attempts, delegation depth, duration, reports, and artifacts.

For client preferences, use `programs.pituitary` in Home Manager:

```nix
programs.pituitary = {
  enable = true;
  model = "anthropic/your-model";          # local conversations
  glyphs = "plain";                       # or "nerd-font"
  animations = true;
  footer.palette = "ember";
  firelight.reach = "close";
  keybindings."app.model.select" = "alt+m";
};
```

The [Home Manager module](../../modules/home-manager/pituitary.nix) lists appearance,
editor, logging, state-directory, and remote-socket options. Its wrapper scopes the
environment to Pituitary. `PITUITARY_STATE_DIR` selects private host state;
`PITUITARY_RUNTIME_SOCKET` selects an existing runtime without starting a local one.

## Remote frontend

The same frontend attaches through an SSH Unix-socket tunnel:

```sh
ssh host pituitary socket
ssh -NT -L "$XDG_RUNTIME_DIR/pituitary.sock:/remote/runtime/socket" host
pituitary attach feature --socket "$XDG_RUNTIME_DIR/pituitary.sock"
```

Use the socket path reported by the remote host. The host keeps its harness,
credentials, and Bay environments; the client owns terminal presentation and input.

## Terminal

The editor embeds a clean, pinned Neovim, with a plain editor fallback. It starts in
insert mode, wraps between words, and grows with the draft. `PITUITARY_NVIM` selects
another executable; `PITUITARY_EDITOR`, `$VISUAL`, and `$EDITOR` select external editing.

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
provide conversation controls. Declared roles keep their model fixed. `/` completes
commands and `@` completes paths. The footer shows the directory, branch, conversation,
model, context, and usage. GitHub CLI supplies the branch's pull request;
`PITUITARY_GH=""` disables that lookup.

`PITUITARY_PLAIN_GLYPHS=1` selects plain symbols. `PITUITARY_STILL=1` holds animation.
Fire, firelight, and footer settings are exposed by the Home Manager module. Terminal
behavior follows negotiated capabilities. Protocol tests cover synchronized frames
directly and through tmux; no terminal emulator identity is assumed at runtime.

## Develop without rebuilding the system

```sh
cd packages/pituitary
nix develop ../..#pituitary
bun install
just run tool 40                        # native Faux model; no credentials
just live --watch --model provider/model
just harness attach feature --watch
```

Source runs execute TypeScript directly. `--watch` restarts only the frontend after a
UI source change; `ctrl+r` and `/reload-ui` request the same orderly restart. Drafts and
viewports survive. The host harness and Bay work keep running. Restart the host runtime
to load host application changes; native tasks resume from their checkpoints. Role
changes affect new runs. Only machine changes require an image build.

The dev shell isolates caches and host state inside this checkout. Installed wrapper
preferences are not implicitly copied into source launches.

| Path | Responsibility |
| --- | --- |
| `packages/harness` | Native workflows, domain tools, Bay adapter, artifacts, host API, CLI |
| `packages/session` | Frontend presentation events, state reduction, and pacing |
| `packages/tui` | Editor, transcript, team navigation, and renderer |
| `packages/ember` | Fire and light primitives |
| `e2e` | Native provider-free terminal scenarios and performance evidence |

Validation is batched at major milestones. `just loop` runs typechecking, formatting,
unit tests, PTY scenarios, latency budgets, package, and Home Manager gates; it writes
`artifacts/report.md`, logs, and captured screens. Inspect the `.txt` and `.png` screens.
`just tui` drives a native test conversation interactively. Bay's real VM checks live
in Realm's flake tests. New source files must be tracked for Git-backed flake builds.

`bun.lock` pins dependencies. To renew the production dependency hash after changing
it, set `outputHash` in `default.nix` to `lib.fakeHash`, build `../..#pituitary`, and use
the reported hash.

The former [Pituitary repository](https://github.com/gshpychka/pituitary) is retired;
Realm owns its source, package, modules, and development workflow.
