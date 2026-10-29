# ProbaBench

Can language models sample the probabilities they are given? ProbaBench asks for
`1` with probability `x`, repeats that request across a probability sweep, and
plots the observed frequency. Every saved sample contributes to its model's evidence.
OpenRouter is the only provider. The Method tab explains the
calibration error, the 95% Wilson intervals and their caveats.

## Run locally

From the Realm root:

```sh
nix develop .#infra
cd infra/probabench
sops ../../secrets/infra/probabench.env  # once: OPENROUTER_API_KEY=<OpenRouter API key>
bun install --frozen-lockfile
bun run dev
```

`bun run dev` serves the web app from Vite on localhost with the key decrypted
through `sops exec-env`. Its dev bridge lets the page start a benchmark: it
accepts same-origin requests only, runs one benchmark at a time by spawning the
CLI, and limits a browser run to one model, 10,000 samples per target
probability, 100,000 samples in total and a ceiling of 256 concurrent requests.
Concurrency adjusts automatically to OpenRouter's limits, just as in the CLI.
Edits to the domain package or the bridge restart Vite; a running benchmark
survives the restart.
`bun run dev:alchemy` runs the same Vite server under Alchemy's dev runtime,
with local state; it deploys nothing and needs no cloud login.
`bun run build && bun run --cwd packages/web preview` serves the production
build as published, without the dev bridge.

## CLI

The infra shell's `probabench` runs the CLI from any directory with the key
decrypted:

```sh
probabench --list   # saved models; any OpenRouter model ID works too
probabench --model claude-haiku-5.5-off --dry-run
probabench --model claude-opus-5.5-low,gemini-4-argon-low --yes
probabench --model openai/gpt-6.1-sol --reasoning low --trials 10 --step 25
probabench --model all --trials 10 --step 25   # 50 samples per saved model
probabench --help   # every option and its default
```

`--model` takes comma-separated saved names or OpenRouter model IDs. `all` selects
the entire saved list below, defined in `packages/domain/src/plan/models.ts`.
These are fixed versions checked against [OpenRouter's catalog](https://openrouter.ai/models)
on 2026-10-29, covering the current Claude and GPT tiers, the Gemini and Meta
flagships, Grok, DeepSeek, Alibaba Qwen, Moonshot Kimi, Z.ai GLM and MiniMax.

| Saved name | OpenRouter model ID | Reasoning |
| --- | --- | --- |
| `claude-haiku-5.5-off` | `anthropic/claude-haiku-5.5` | Off |
| `claude-sonnet-5.5-low` | `anthropic/claude-sonnet-5.5` | Low |
| `claude-opus-5.5-low` | `anthropic/claude-opus-5.5` | Low |
| `claude-fable-5.1-low` | `anthropic/claude-fable-5.1` | Low |
| `gpt-6-astra-low` | `openai/gpt-6-astra` | Low |
| `gpt-6.1-sol-low` | `openai/gpt-6.1-sol` | Low |
| `gpt-6.1-terra-off` | `openai/gpt-6.1-terra` | Off |
| `gemini-4-argon-low` | `google/gemini-4-argon` | Low |
| `grok-4.7-low` | `x-ai/grok-4.7` | Low |
| `muse-wonder-minimal` | `meta/muse-wonder` | Minimal |
| `deepseek-v4.1-flash-1017-off` | `deepseek/deepseek-v4.1-flash-1017` | Off |
| `qwen3.8-max-0902-minimal` | `qwen/qwen3.8-max-0902` | Minimal |
| `kimi-k3.1-pro-off` | `moonshotai/kimi-k3.1-pro` | Off |
| `glm-5.3-low` | `z-ai/glm-5.3` | Low |
| `minimax-m3.1-flash-low` | `minimax/minimax-m3.1-flash` | Low |

Saved models use the lowest supported reasoning setting: off for Haiku, Terra,
DeepSeek, and Kimi; minimal for Muse Wonder and Qwen; low for the remaining models.
A saved name is a shortcut for the model ID and that setting. `--reasoning`
overrides it. A full model ID defaults to off, so specify a supported reasoning
effort when the model requires it.
`--reasoning` accepts `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`;
choose a setting the model supports. Muse Wonder and Qwen 3.8 Max support `minimal`:

```sh
probabench --model meta/muse-wonder --reasoning minimal
```

The list has 15 models: `--model all` targets 8,250 samples per day at Standard settings,
or 750 with `--trials 10 --step 25`. Already saved answers count toward that total.
`--dry-run` shows the missing requests and estimates their cost from OpenRouter’s
live model pricing API. It needs no key and sends no sampling requests.

`--trials` and `--step` default to the Standard preset, which the page's form
also starts from: a daily total of 50 samples at each probability, every 10%. The CLI
prints the plan and asks before running unless `--yes` is given; without a
terminal it refuses. A completed daily target exits immediately, without confirmation
or credentials. `--dry-run` stops after the plan and cost estimate.

During sampling, an interactive terminal shows a live table with saved samples,
active requests, retries, and each model’s status. Cooldowns count down in place.
Progress counts answers only after they are saved, including invalid replies;
earlier samples reused toward today’s target are excluded from this invocation’s
counts. Average throughput includes all elapsed time, including cooldowns. After
30 seconds and five newly saved answers per unfinished model, ETA uses the longest
remaining time estimated from each model’s average throughput. It stays visible
during cooldowns and accounts for any wait before requests can resume. Redirected output has no
terminal control sequences: it prints totals every 10 seconds, per-model details
every minute, and a final summary on completion, failure, or interruption.

Before confirmation, the CLI shows one table of models, reasoning settings,
missing requests, and estimated USD costs, followed by a total. Models whose daily
targets are met are marked Already saved. The local page shows its estimate before
Start benchmark. Totals below one cent are shown as `<$0.01`. Estimates include
input, output (including reasoning), and any per-request charge. Input tokens are
approximated from the actual prompts using four characters per token plus chat
overhead. The range uses one output token through the configured output limit:
16 when reasoning is off, otherwise `--max-tokens` (default 4,096). It is a range
of token-use scenarios, not a guaranteed spending cap. Provider routing, actual
token counts, credit purchase fees and taxes can change the final charge. Missing
or invalid prices are shown as unavailable rather than counted as free. If the
pricing API is unavailable, sampling can still proceed after that is shown.

## Daily sampling and checkpoints

The daily target is tracked separately for each model, reasoning setting and
requested probability. The day is the UTC date when sampling starts; that date
stays fixed if sampling crosses midnight. All returned answers count toward the
trial total, including invalid replies. Failed requests without an answer do not.

```sh
probabench --model grok-4.7-low --trials 50 --step 10
probabench --model grok-4.7-low --trials 50 --step 10   # same day: no new requests
probabench --model grok-4.7-low --trials 100 --step 10  # adds 50 per probability
probabench --model grok-4.7-low --trials 100 --step 5   # fills the new probabilities
```

A lower trial target or a coarser grid never removes answers. A new day starts a
new daily target while preserving the complete history. Checkpoints are saved as
answers arrive, including partial probability grids. Stop with Ctrl-C and repeat
the command to collect only the missing answers.

Samples use the provider's default temperature, top_p and top_k. A reply may use
16 output tokens with reasoning off, or `--max-tokens` (4096 by default) with it
on; a model that cannot turn reasoning off can spend those 16 thinking and
record an invalid reply.

All selected models and target probabilities are sampled in parallel. Scheduling
starts with a few requests, increases concurrency after successful replies, and
reduces it when OpenRouter reports throttling. A provider limit pauses that model;
an account limit pauses the shared queue. Free-model quotas are shared separately.
`--concurrency` sets the global ceiling across the entire benchmark (256 by default),
so selecting more models does not multiply the ceiling. Lower it to limit resource
use, or raise it for a larger workload. The browser uses the same default.

An attempt times out after two minutes, starting when it is admitted to the provider.
Timeouts, transport failures, 408, 429 and 5xx responses retry up to five times with
jittered exponential backoff. The scheduler honors the full `Retry-After` or exhausted
quota reset delay, releasing capacity while waiting. Temporary in-flight spending
holds also back off and retry; exhausted credits and other permanent errors stop
that model. Other models finish and save their samples before the CLI reports failure.
See [OpenRouter's limits](https://openrouter.ai/docs/api/reference/limits).

## Evidence and history

`data/results.json` holds the raw observations and is their only source copy.
The CLI appends immutable checkpoints whether started in a terminal or by the dev
bridge. Each received answer is committed before its task completes. Concurrent
replies can share a disk write; interruption waits for those commits to finish.
Commit the file after collecting samples:
`bun run deploy` publishes the working-tree copy, committed or not.

The results page combines all observations of a model with the same reasoning setting.
At each target probability it pools the counts of ones, zeros and invalid replies,
then computes the observed frequency, Wilson interval and calibration error.
Different sampling grids contribute only at the targets they actually measured.
An invocation's boundaries, its ID and how many samples it collected have no
independent statistical weight. Repeating a benchmark adds evidence to the same
model instead of replacing its chart with the newest collection. Repeating an
already completed daily target leaves the history unchanged.

The **Over time** view plots mean absolute error using all answers collected by
each date. Select a graph point to inspect measurements at that date, or choose
Show latest to return to the current totals. Results always shows all collected
answers. Model selection, historical date, visibility and confidence intervals
are reflected in the URL and work with browser navigation. Invalid observations
remain counted even when earlier valid samples exist. The stored `runs` array
and IDs are internal bookkeeping; neither is a user-facing unit of comparison.

The runner reads the final answer directly from OpenRouter's chat-completions
response. It validates the answer fields and ignores reasoning metadata, whose
provider-specific formats are unrelated to the measurement.

Concurrent invocations share a file lease. The second waits for the first, then
rechecks the saved totals before sending requests. The lease is released on exit;
after a hard kill, a stale lease expires after 30 seconds. Each save atomically
replaces the JSON snapshot through a temporary `.probabench-*` directory beside the history, and
a process killed mid-save can leave it behind. Delete it: `bun run deploy`
publishes everything in `data/`.

## Deploy

```sh
# once: CLOUDFLARE_ACCOUNT_ID=<account ID> and CLOUDFLARE_API_TOKEN=<API token>
sops ../../secrets/infra/probabench.env

bun run plan
bun run deploy    # publishes https://probabench.<domain>
bun run destroy   # deletes the Worker, and with its domain the DNS record and certificate
```

The scripts read the token through `sops exec-env`. Give it these permissions,
restricting Account Resources to the target account and Zone Resources to the
domain's zone:

| Scope | Permission | Access |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | Secrets Store | Edit |
| Zone | Workers Routes | Edit |
| Zone | Zone | Read |

Alchemy keeps deployment state in Cloudflare through `Cloudflare.state()`,
scoped to the `ProbaBench` stack and `prod` stage. The first `bun run plan` or
`bun run deploy` prompts to provision the account-wide `alchemy-state-store`
Worker, backed by a Durable Object with SQLite. Its authentication token and
encryption key live in Cloudflare Secrets Store; Secrets Store Edit is required
to create and bind those secrets. The state-store Worker uses a `workers.dev`
address, so the account needs a Workers subdomain configured. Later deployments
reuse the store, which is shared with other Alchemy stacks on the account.
`bun run destroy` removes the ProbaBench site; the shared state store remains.
No AWS credentials or bootstrap are needed.

The infra shell keeps Alchemy profiles and cached state-store credentials under
`infra/.home/.alchemy`. To provision the state store explicitly before a CI
deployment, use the command for the pinned Alchemy version, from this directory:

```sh
sops exec-env ../../secrets/infra/probabench.env 'bun run --cwd packages/stack alchemy provider cloudflare bootstrap'
```

Local Alchemy development uses `.alchemy/` under `packages/stack` instead of the
remote store. Benchmark history remains in `data/results.json`; it is separate
from deployment state. See [Alchemy's state-store documentation](https://alchemy.run/state-store/).

`packages/stack/alchemy.run.ts` builds `packages/web` with the working-tree
history and uploads it as an assets-only Cloudflare Worker, so the hosted site
changes only on deploy. With no Worker code, every request is a static-asset
request, which the Free plan serves at no charge and outside the Workers request
quota. `probabench.<domain>` is a Workers custom domain: Cloudflare creates its
DNS record and certificate. The infra shell exports the domain from
`modules/common/values.nix` as `DOMAIN_NAME`.

## Development

| Package | Contents |
| --- | --- |
| `packages/domain` | Results schema and metrics, run-plan vocabulary, the runner's flags and progress lines |
| `packages/runner` | The OpenRouter CLI |
| `packages/web` | The results UI, and `dev-bridge/`, the Vite plugin that runs the CLI |
| `packages/stack` | The Alchemy stack |

The application packages use Effect 3; the stack uses Effect 4, as
link-sanitizer does.

```sh
bun run check   # types, tests and the production build; no test calls OpenRouter
```

`nix build .#checks.x86_64-linux.probabench` runs the same check offline from
`bun.nix`, which `bun install` regenerates; commit it with `bun.lock`. `nix fmt`
formats with Realm's Biome config, and `nix flake check` lints with it. Biome's
noDescendingSpecificity is off for these stylesheets: classes style their own
children (`.x > span`), which the rule reports as conflicts between unrelated
elements.

ProbaBench source, packages, deployment, and issues are maintained in Realm.
