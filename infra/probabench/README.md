# ProbaBench

Can language models sample the probabilities they are given? ProbaBench asks for
`1` with probability `x`, repeats that request across a probability sweep, and
plots the observed frequency. Every completed run is kept in its history.
OpenRouter is the only provider. The notebook's Method tab explains the
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

`bun run dev` serves the notebook from Vite on localhost with the key decrypted
through `sops exec-env`. Its dev bridge lets the page start a benchmark: it
accepts same-origin requests only, runs one benchmark at a time by spawning the
CLI, and limits a browser run to one model, 10,000 samples per target
probability, 100,000 samples in total and 50 concurrent requests (5 by default).
Edits to the domain package or the bridge restart Vite; a running benchmark
survives the restart.
`bun run dev:alchemy` runs the same Vite server under Alchemy's dev runtime,
with local state; it needs Docker for Alchemy's AWS emulator.
`bun run build && bun run --cwd packages/web preview` serves the production
build, the notebook as published, without the dev bridge.

## CLI

The infra shell's `probabench` runs the CLI from any directory with the key
decrypted:

```sh
probabench --list   # model aliases; any OpenRouter model ID works too
probabench --model claude-haiku-4.5 --dry-run
probabench --model anthropic/claude-haiku-4.5,google/gemini-2.5-flash --yes
probabench --model openai/gpt-5-mini --reasoning low --trials 10 --step 25
probabench --help   # every option and its default
```

`--model` takes comma-separated aliases or OpenRouter model IDs, or `all` for
every alias. The aliases are in `packages/domain/src/plan/models.ts`;
`--reasoning` overrides an alias's mode, and a model ID defaults to off.
`--trials` and `--step` default to the Standard preset, which the page's form
also starts from: 50 samples at each target probability, every 10%. The CLI
prints the plan and asks before running unless `--yes` is given; without a
terminal it refuses. `--dry-run` stops after the plan.

Samples use the provider's default temperature, top_p and top_k. A reply may use
16 output tokens with reasoning off, or `--max-tokens` (4096 by default) with it
on; a model that cannot turn reasoning off can spend those 16 thinking and
record an invalid reply. Target probabilities are sampled one after another, so
`--concurrency` (10 by default) bounds the requests in flight at each one. An
attempt times out after two minutes; timeouts, transport failures, 408, 429 and
5xx responses retry up to five times, honoring `Retry-After` for up to a minute,
and any other failure aborts the benchmark.

## History

`data/results.json` is the history and its only copy. The CLI appends to it,
whether started in a terminal or by the dev bridge, and the notebook reads it.
Each model's run is appended as soon as it completes, so an aborted or cancelled
benchmark keeps the runs it finished and loses only the one in progress. Commit
the file after each benchmark: `bun run deploy` publishes the working-tree copy,
committed or not.

Saves are not serialized across processes, so run one benchmark at a time. Each
save goes through a temporary `.probabench-*` directory beside the history, and
a process killed mid-save can leave it behind. Delete it: `bun run deploy`
publishes everything in `data/`.

## Deploy

```sh
bun run plan
bun run deploy   # bun run destroy removes the prod stage, not the bootstrap bucket
```

`packages/stack/alchemy.run.ts` builds `packages/web` with the working-tree
history and serves it from a private S3 bucket behind CloudFront, so the hosted
site changes only on deploy. It uses the Alchemy profile and the account's
assets bucket from [link-sanitizer's one-time steps](../link-sanitizer/README.md#deploy).
`patches/` carries
[alchemy-run/distilled#650](https://github.com/alchemy-run/distilled/pull/650),
as link-sanitizer does, so SSO profiles resolve from the infra shell's
`AWS_CONFIG_FILE`.

## Development

| Package | Contents |
| --- | --- |
| `packages/domain` | Results schema and metrics, run-plan vocabulary, the runner's flags and progress lines |
| `packages/runner` | The OpenRouter CLI |
| `packages/web` | The notebook, and `dev-bridge/`, the Vite plugin that runs the CLI |
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

Imported from the standalone probabench repository at `3694e6a`; that
repository and its flake are retired.
