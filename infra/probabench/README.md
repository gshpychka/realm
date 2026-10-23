# ProbaBench

Can language models sample the probabilities they are given? ProbaBench asks for
`1` with probability `p`, repeats that request across a probability sweep, and
plots the observed frequency. Every completed sweep is kept in its history.
OpenRouter is the only provider.

## Start here

From the Realm root:

```sh
nix develop .#infra
cd infra/probabench
bun install --frozen-lockfile
cp .env.example .env.local
# Set OPENROUTER_API_KEY in .env.local.
bun run dev
```

Open the local URL, select **New benchmark**, choose an OpenRouter model and a
sampling preset, then start. The page shows progress, supports cancellation,
and refreshes the charts after completion. Adding or changing the key in
`.env.local` takes effect without restarting the server.

The local runner listens on loopback, accepts same-origin requests only, and
runs one benchmark at a time. API keys stay in the server environment; the page
never asks for one. Provider requests incur charges. The form shows sample and
maximum retry budgets before starting; monetary cost depends on the model and
its actual token usage.

Quick uses 50 samples, Standard 550, and Thorough 2,100. Custom trial counts,
probability steps, concurrency and reasoning are available. Browser runs allow
up to 100,000 samples and 50 concurrent requests. The CLI supports larger runs.
Presets keep the setup short; custom budgets and advanced settings open only
when needed. During a run, progress comes first and the full runner output is
available separately. Closing the dialog keeps the benchmark running; reopen
**View progress** to check it or cancel. **View results** opens refreshed history.

## Run from the terminal

```sh
# Guided model and sampling setup in an interactive terminal.
bun run bench

# List the convenience aliases; any OpenRouter vendor/model ID also works.
bun run bench --list

# Inspect a plan without credentials or any model requests.
bun run bench --model anthropic/claude-haiku-4.5 --trials 10 --step 25 --dry-run

# Run a small sweep; omit --yes to review an interactive confirmation.
bun run bench --model anthropic/claude-haiku-4.5 --trials 10 --step 25 --yes

# Compare models and enable reasoning explicitly when the model supports it.
bun run bench --model anthropic/claude-sonnet-4.5,google/gemini-2.5-flash --trials 100 --yes
bun run bench --model openai/gpt-5-mini --reasoning low --trials 20 --yes
```

Bun loads `.env.local` automatically. You can also export
`OPENROUTER_API_KEY` in your environment. A noninteractive command needs both
`--model` and `--yes` (or `--dry-run`).

| Option | Default | Meaning |
| --- | --- | --- |
| `--model`, `-m` | guided setup | OpenRouter IDs or aliases, comma-separated; `all` expands every alias |
| `--list` | off | Show available convenience aliases |
| `--trials` | `100` | Samples at each probability |
| `--step` | `10` | Probability step in percent, 1–100; always includes both endpoints |
| `--concurrency` | `10` | Maximum simultaneous requests within a probability step |
| `--reasoning` | alias config, otherwise off | `off`, `low`, `medium`, `high`, `xhigh` |
| `--max-tokens` | `4096` | Output token ceiling for reasoning targets |
| `--out` | `packages/web/public/data/results.json` | History file; the default resolves from the runner, independent of the current directory |
| `--yes`, `-y` | off | Confirm execution without prompting |
| `--dry-run` | off | Validate and print the plan without provider calls |

Model IDs and reasoning support depend on OpenRouter. The small alias list in
[`models.ts`](packages/domain/src/models.ts) is optional; no code change is
needed to use another OpenRouter model. Explicit reasoning overrides the alias
configuration. Distinct reasoning modes remain distinct chart series.

Each sample uses a fresh system/user prompt. `temperature`, `top_p`, and `top_k`
retain provider defaults. Only trimmed `0` or `1` is valid; other responses are
recorded as invalid text. Attempts time out after two minutes. Transport
failures, rate limits and server errors retry at most five times, honoring
`Retry-After`; permanent failures abort.

## Explore results

The Gruvbox dark dashboard has a calibration plot, model filters, a benchmark
history graph, and a run inspector. Select a history point or a recorded run to
inspect its calibration curve and measurements. History tracks mean absolute
calibration error in percentage points; lower measured error is better, subject
to sample noise. Runs with no valid measurements have no score.

The calibration diagonal is the expected frequency: a 30% target should produce
about 30% ones. Error bars are pointwise 95% Wilson intervals assuming independent
valid samples. Invalid replies are excluded from observed frequencies and shown
separately; review both validity and point coverage before comparing scores.
Scores average absolute error equally across points with valid replies.
Different grids, trial counts, reasoning settings, and missing measurements can
change scores. Small samples can make even calibrated models appear inaccurate.

Model filters apply to both the history graph and its list. Search matches model
IDs, reasoning and run IDs. The selected run always belongs to the visible set.
Keyboard users can select graph points with Enter or Space, or use the list.
Model colors stay stable as runs append; additional line patterns distinguish
models when the palette repeats. Calibration curves retain their own target
grids when comparing runs with different sampling steps.

**Copy view link** saves the view, selected snapshots, filters and uncertainty
display in the address. A copied comparison keeps its exact runs even when newer
measurements are added. Browser Back and Forward restore the view. In the run
inspector, **Run again** fills in the recorded model, grid and reasoning for
review before starting; concurrency defaults to five because it is not recorded
in historical results. **Download JSON** exports that run with its raw outcomes
as a validated version 2 results document.

History is append-only. Each completed sweep has a unique execution ID, model,
reasoning mode, timestamp, settings and raw outcomes. Rerunning a model keeps
its earlier sweeps. Every save validates history, flushes
a temporary file and atomically renames it. Invalid existing history fails
before paid requests. A short filesystem lock serializes saves across the local
page and independent CLI processes, so simultaneous completed runs retain both
entries. A writer waits up to five seconds for a busy history file. If a process
is forcibly killed while saving, its `<results-path>.lock` and a `.probabench-*`
temporary directory beside it may remain: verify no writer is active, then
remove them before retrying or building. Cancellation
or failure keeps completed sweeps; the current incomplete sweep is not saved.

The committed history starts empty. No fabricated measurements are published.

## Publish with Alchemy

```sh
bun run plan
bun run deploy
```

The stack publishes the Vite build and current history to private S3 behind
HTTPS CloudFront, using AWS-backed state and a fixed `prod` stage. It waits for
CDN invalidation. HTML and history revalidate; hashed assets are immutable.

The published page is a results explorer with a copyable benchmark command.
The local execution API exists only in the development server. Run experiments
locally, then deploy to publish the updated history. See
[`infra/README.md`](infra/README.md) for AWS configuration and teardown.

## Development

The Bun workspace contains `packages/domain` (validated contracts and metrics),
`packages/runner` (OpenRouter CLI), `packages/web` (dashboard and local development
bridge), and `infra` (Alchemy). Application code uses Effect 3; the isolated
Alchemy 2 workspace uses Effect 4, matching Link Sanitizer.

```sh
bun run check      # types, offline tests, production build
bun run lint       # Realm Biome checks
bun run format
```

`bun install` regenerates `bun.nix` through the pinned infra-shell bun2nix.
Commit `bun.lock` and `bun.nix` together after dependency changes. Realm CI runs
`nix build .#checks.x86_64-linux.probabench`, which installs locked dependencies
and runs the checks in the Nix sandbox. No test needs live provider credentials.

ProbaBench was imported into Realm from `~/projects/personal/probabench` at
`3694e6a`; the previous standalone flake and pnpm tooling are retired.
