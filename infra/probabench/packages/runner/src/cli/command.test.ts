import { existsSync } from "node:fs";
import * as Command from "@effect/cli/Command";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import { benchArgs } from "@probabench/domain";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { MISSING_MODEL_MESSAGE } from "../plan/plan";
import { ResultsStore } from "../store/results-store";
import { benchCommand, DEFAULT_OUT, NON_TTY_MESSAGE } from "./command";

// Vitest's stdin is not a TTY, so these cover the non-interactive path.
const runCommand = (args: readonly string[]) =>
  Command.run(benchCommand, { name: "probabench", version: "test" })([
    "node",
    "probabench",
    ...args,
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(ResultsStore.Default, FetchHttpClient.layer).pipe(
        Layer.provideMerge(NodeContext.layer),
      ),
    ),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
  );

/** The message of the InvalidOptions a command fails with. */
const invalidOptions = (args: readonly string[]) =>
  Effect.flip(runCommand(args)).pipe(
    Effect.map((error) => (error._tag === "InvalidOptions" ? error.message : error._tag)),
  );

describe("probabench command", () => {
  for (const [flag, value] of [
    ["step", "0"],
    ["step", "101"],
    ["step", "1.5"],
    ["trials", "-1"],
    ["trials", "9007199254740992"],
    ["concurrency", "0"],
    ["max-tokens", "0"],
    ["reasoning", "bogus"],
    ["out", ""],
  ] as const) {
    it.effect(`rejects --${flag} ${JSON.stringify(value)} before planning`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          runCommand(["--model", "all", "--dry-run", `--${flag}`, value]),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  }

  it.effect("rejects unknown models mixed with valid ones, even with --yes", () =>
    Effect.gen(function* () {
      expect(yield* invalidOptions(["--model", "vendor/model,typo", "--yes"])).toBe(
        "Unknown models: typo. Use --list or an OpenRouter model ID (vendor/model).",
      );
    }),
  );

  it.effect("asks for a model instead of starting guided setup", () =>
    Effect.gen(function* () {
      expect(yield* invalidOptions([])).toBe(MISSING_MODEL_MESSAGE);
    }),
  );

  it.effect("requires --yes to run without a terminal to confirm in", () =>
    Effect.gen(function* () {
      expect(yield* invalidOptions(["--model", "vendor/model"])).toBe(NON_TTY_MESSAGE);
    }),
  );

  it("defaults --out to the workspace's tracked history", () => {
    expect(existsSync(DEFAULT_OUT)).toBe(true);
  });

  it.effect("lists aliases without credentials", () => runCommand(["--list"]));

  it.effect("parses the flags the dev bridge and setup form build, without credentials", () =>
    runCommand([
      ...benchArgs({
        model: "vendor/future-model:free",
        trialsPerStep: 2,
        stepPercent: 30,
        concurrency: 5,
        reasoning: "low",
      }),
      "--dry-run",
    ]),
  );
});
