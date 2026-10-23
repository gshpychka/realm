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

`bun run dev` serves the notebook from Vite on 127.0.0.1 with the key decrypted
through `sops exec-env`. Its dev bridge lets the page start a benchmark: it
accepts same-origin requests only, runs one benchmark at a time by spawning the
CLI, and limits a browser run to one model, 10,000 samples per target
probability, 100,000 samples in total and 50 concurrent requests (5 by default).
`bun run dev:alchemy` runs the same Vite server under Alchemy's dev runtime,
with local state; it needs Docker for Alchemy's AWS emulator.

## CLI

The infra shell's `probabench` runs the CLI from any directory with the key
decrypted:

```sh
probabench          # guided setup in an interactive terminal
probabench --list   # model aliases; any OpenRouter model ID works too
probabench --model claude-haiku-4.5 --trials 10 --step 25 --dry-run
probabench --model anthropic/claude-haiku-4.5,google/gemini-2.5-flash --trials 100 --yes
probabench --model openai/gpt-5-mini --reasoning low --trials 20 --yes
probabench --help   # every option and its default
```

It prints the plan, with its sample count and worst-case provider attempts, and
asks before running unless `--yes` is given; without a terminal it refuses.
`--dry-run` stops after the plan. The aliases are in
`packages/domain/src/plan/models.ts`; `--reasoning` overrides an alias's mode,
and a model ID defaults to off.

Samples use the provider's default temperature, top_p and top_k. An attempt
times out after two minutes; timeouts, transport failures, 408, 429 and 5xx
responses retry up to five times, honoring `Retry-After` for up to a minute, and
any other failure aborts the benchmark.

## History

`data/results.json` is the history and its only copy. The CLI appends to it,
also when the dev bridge starts it, and the notebook reads it. Each model's run
is appended as soon as it completes, so an aborted or cancelled benchmark keeps
the runs it finished and loses only the one in progress. Commit the file after
each benchmark: `bun run deploy` publishes the working-tree copy, committed or
not.

Saves hold `results.json.lock`. A writer that finds it waits five seconds, then
fails and names it. If a killed process left it behind, possibly with a
`.probabench-*` temporary directory, and no benchmark is running, delete both:
`bun run deploy` publishes everything in `data/`.

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
| `packages/domain` | Results schema and metrics, run-plan vocabulary, the progress-line format |
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
