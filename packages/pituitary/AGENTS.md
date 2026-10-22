# Working in this repo

## The loop

`just loop` is the entry point. It writes `artifacts/report.md` with a pass/fail table, the first
failure's log tail, and every rendered screen. Read that file rather than re-running gates one by
one.

## Verifying a change to the UI

A UI change is verified by looking at a rendered screen, not by a passing assertion alone. Run the
e2e suite and read `artifacts/screens/*.txt`. Layout, indentation, and stray glyphs show up there
and nowhere else.

Every UI state worth keeping gets an e2e test that captures it, so the next iteration starts from
a screen it can read.

`just tui` operates a live session the way the operator would: `just tui start --scenario tool`,
`just tui submit "what is here"`, `just tui key esc`, `just tui screen`. `just tui screen --style`
lists every coloured run by row and column, which is how a change carried by colour is verified.
The session persists between commands until `just tui stop`; `TUI_SESSION=name` keeps a separate
one.

`capture` also writes a `.png` beside each `.txt`, for a person reviewing the screens. `boot` runs
any bun entry point under the same harness, and `film` captures successive frames of a screen
that animates; an animated screen boots with `settle: false`, since its output never goes idle.
`launch` sets `PITUITARY_STILL=1`, which holds the fire on one frame in its place; a test of its
motion sets it to `0` and boots with `settle: false`.

The fire is one mascot (`components/mascot.tsx`), the only part of the UI that burns one: screens
offer it room with `MascotSlot`, and it draws over the screen into the slot it prefers,
travelling between them. `e2e/helpers/fire.ts` finds its cells on a captured screen. The harness
reads a frame as it arrives, where a terminal shows a synchronized frame whole, so a reading taken
the moment text appears can hold parts of two frames.

## Timings

`e2e/*.perf.ts` measures key-to-screen latency and rendering speed, one file at a time, and
`packages/rpc/src/perf.test.ts` guards the reducer and decoder against lost linearity. The
report's Timings table lists each figure beside its budget, with the harness's own floor for
reference. The renderer holds frames at least 1/120 s apart, so keys sent faster than that each
wait out the rest of a frame.

`PITUITARY_PROFILE=<file>` makes the UI write a timing mark for each startup and teardown step, and
the harness reads them back through `profile()`. `e2e/lifecycle.test.ts` checks that every way out
leaves no process, socket, or terminal mode behind.

## Protocol facts

pi's RPC framing uses LF as the only record delimiter, so `U+2028` and `U+2029` stay inside string
values. `JsonLineDecoder` implements this; a general-purpose line reader does not.

`message_update` carries a delta and the usage so far, never the message built up so far: RPC
strips it (`JsonAgentSessionEvent`). `toolcall_start` carries the call's id and name. The reducer
folds deltas and treats `message_end` as authoritative; a provider error or an abort arrives only
there, as `stopReason` with `errorMessage`.

`agent_settled` ends a run. `agent_end` arrives with `willRetry` set when pi is about to retry,
and another `agent_start` follows.

Event and command types come from `@earendil-works/pi-coding-agent`. Hand-written copies drift;
`JsonAgentSessionEvent` is what pi writes to stdout.

pi drops a failed reply from the session when it retries, records an operator's `!` command
without an event (at once when idle, just before `agent_settled` otherwise), and writes a session
file only once it holds a reply. The view keeps its own message count by the same rules, and
rebuilds from `get_messages` only when pi's count differs while everything is still, or when the
session id changes.

Every record from pi is scrubbed of control characters before anything reads it: model text, tool
output, and extension text can all carry terminal escapes.

An extension dialog (`select`, `confirm`, `input`, `editor`) blocks pi until the client answers it,
and several can be open at once. pi resolves a dialog on timeout or abort without telling the
client. Extension commands answer their `prompt` only after the handler finishes, so their dialogs
arrive first.

Status, widget, and notify text is styled through pi's theme and carries ANSI and OSC-8 escapes
in every mode; `plain` strips them.

pituitary draws its own links with `Link` (`components/link.tsx`), whose target passes `safeHref`.
OpenTUI writes OSC 8 for a terminal whose reply to its version query names one that draws links,
or that sets `COLORTERM=truecolor`; inside tmux that reply is tmux's own unless passthrough
carries the outer terminal's.
The footer's pull request (`gh pr view`) and `/share`'s secret gist run the GitHub CLI through
`PITUITARY_GH`; set empty, it turns both off. Tests point it at `e2e/fixtures/gh`.

pi's RPC UI context resolves `custom()` at once with nothing and drops component widgets,
`setFooter`, `setHeader`, `onTerminalInput`, and `setEditorComponent`. pituitary loads
`packages/rpc/bridge/extension.ts` into every pi it starts: it wraps each context pi installs
through `ExtensionRunner.setUIContext`, runs components inside pi, and streams their rows to
pituitary over a socket in a directory only the operator can enter. A connection draws only after
its first record carries the token pituitary gave its own pi, and the extension clears the socket
path and token from pi's environment so the processes pi starts never see them. A component
opened before the connection is accepted waits for it. Its `pituitary-*` commands carry
out what RPC has no command for: reload, moving along the tree, and the changelog.

A Claude subscription's usage limits arrive only as `anthropic-ratelimit-unified-*` headers on
successful provider responses, which pi hands extensions as `after_provider_response`. The bridge
forwards those headers and no others, and both ends filter by that prefix. A request refused
outright raises before the event fires.

A move along the tree keeps the session id and the message count, so the view rebuilds only
when asked to. Built-in commands that need pi's own interface (login, logout) hand the terminal
to stock pi on the same session, with the RPC agent stopped so one pi at a time writes the session
file. What pi reads only as it starts, trust and the scoped models, takes effect through a fresh
RPC agent on the same session.

The agent's stderr never reaches the terminal, which would corrupt the rendered frame. It goes to
`PITUITARY_LOG`.

## Test backend

Tests drive the scripted agent in `packages/fake-pi`, never a model provider. Its `write` is typed
as `PiEvent | RpcResponse`, so a scripted record pi could not emit fails the typecheck.

Real pi runs in e2e only where no model is involved: an extension command from `e2e/fixtures`
confirms that pi emits the shapes the scripted agent imitates.

New protocol behaviour goes into `packages/rpc/src/scripted.ts` first, so the reducer's tests
and the scripted agent exercise the same event shapes.

## Packaging

Realm's flake exports this workspace as `packages.<system>.pituitary`. New files must be tracked
before a Git-backed flake build includes them. The installed dependencies are pinned by hash;
`README.md` says how to renew it when `bun.lock` changes. Run development commands from this
directory after entering `nix develop ../..#pituitary`.

`../../modules/home-manager/pituitary.nix` maps each option to an environment variable set in the
installed wrapper; an option pituitary gains goes there. The `module` gate builds
`../../tests/pituitary-home-manager.nix`, a home with every option set, and reads them back.

## Isolation

The dev shell keeps caches, pi sessions, and artifacts inside the working tree. The e2e harness
gives each run a throwaway `HOME`, so a test reads and writes none of the operator's pi state,
and starts the UI without the variables that describe the operator's own terminal (`TMUX`,
`TERM_PROGRAM`, and the like), so OpenTUI judges tui-test's terminal by `TERM` and `COLORTERM`.
