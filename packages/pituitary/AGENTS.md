# Working on Pituitary

This is fully greenfield. Implement and document only the steady state. There are no
legacy paths, backwards compatibility, migrations, or upgrade scaffolding. Prefer
deleting our code whenever upstream owns the concern. Preserve code only when its
behavior belongs in the product.

## Architecture

Pituitary is the frontend for regular Pi and Dura. Plain `pituitary` starts the
configured Pi executable over RPC, retaining its auth, settings, and extensions, and
loads Pituitary's own Pi extension for ChatGPT Fast mode (`packages/tui/src/pi-fast.ts`).
`pituitary --dura RUN` uses Dura's pure connection client. Keep their lifecycle and
configuration separate; share the interface through `ConversationLink`.

Read `../dura/docs/orchestration.md` for the durable domain. Dura owns workflows,
credentials, and authority. Bay owns execution environments. The frontend imports
only `@realm/dura/client` and `@realm/dura/types`, never server modules.

`packages/session` defines the frontend presentation contract and reducer. Translate
native snapshots and committed events at the conversation bridge. The terminal is a
disposable observer with an explicit input lease. Its state is not authoritative
orchestration state. `packages/tui` owns presentation and interaction.

## Validation

Checks are expensive. Complete and review a coherent milestone before running its
gates together. Rerun only gates affected by concrete failures. `just loop` runs the
package's full batch and writes `artifacts/report.md`, per-gate logs, timings, and
captured screens. Read those results before running more commands.

A UI change needs visual inspection. E2E captures write text, SVG, and PNG under
`artifacts/screens`; inspect compact and wide states, attention, results, and reload.
Assertions alone do not establish layout quality. Native harness scenarios use a real Harness
with the Faux provider, never an external model or a duplicate agent backend.

`just tui start --scenario tool`, `just tui submit "what is here"`, `just tui key esc`,
and `just tui screen --style` operate a persistent native test conversation.
`TUI_SESSION=name` selects another driver session. `boot` can run any Bun entry point
under the PTY harness. `film` captures animation frames; animated screens use
`settle: false`. Default scenarios set `PITUITARY_STILL=1`.

Performance scenarios live in `e2e/*.perf.ts`. Run them without competing test jobs.
`PITUITARY_PROFILE` records startup and teardown marks. Preserve meaningful editor,
streaming, terminal cleanup, and input-latency coverage as the architecture changes.
Remove tests for removed product paths rather than emulating those paths in fixtures.

## Terminal correctness

Scrub model and tool text before rendering terminal controls. Construct links through
`safeHref` and `Link`. Preserve LF-only record framing: Unicode U+2028 and U+2029 are
valid string contents. Native snapshots are authoritative; do not invent transcript
replay state to repair presentation.

Use negotiated capabilities, never a required terminal identity. The PTY harness
isolates the operator's `TMUX`, `TERM_PROGRAM`, and related environment. Dedicated
protocol tests inspect complete synchronized frames directly and through a private
real tmux server. Terminal-type fixtures do not claim to launch GUI emulators.

The OpenTUI patch in `patches/` fixes pending-highlight visibility, wrapped measurement,
and disabled-scrollbar first-frame displacement. Keep it until the corresponding
rendering evidence passes without it.

The mascot is one fire rendered by `components/mascot.tsx`; views provide slots through
`MascotSlot`. `e2e/helpers/fire.ts` identifies its captured cells. A PTY read can arrive
mid-frame, so inspect synchronized frame boundaries for flicker regressions.

## Packaging and isolation

Enter `nix develop ../..#pituitary` from this directory. The dev shell keeps caches,
native host state, and artifacts in the checkout. PTY tests use throwaway homes.
Provider secrets and operator state must never enter test fixtures or guest images.

Realm exports separate Pituitary and Dura packages, the Pituitary Home Manager
module, and the Dura NixOS host/agent modules. New files must be tracked before a
Git-backed flake build. The root `bun.lock` and `../agent-workspace.nix` pin
production dependencies. `README.md` explains hash
renewal. Map client options in `modules/home-manager/pituitary.nix` and cover them with
`tests/pituitary-home-manager.nix`. Agent metadata remains outside image derivations.
