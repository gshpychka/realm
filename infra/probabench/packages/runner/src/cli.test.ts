import * as Command from "@effect/cli/Command";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import { MODEL_ALIASES } from "@probabench/domain";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { Benchmark } from "./benchmark";
import {
  benchCommand,
  confirmationGate,
  describePlan,
  MISSING_MODEL_MESSAGE,
  NON_TTY_MESSAGE,
  resolvePlan,
  TRIAL_PRESETS,
  xStepCount,
} from "./cli";
import { ResultsStore } from "./results-store";

const runCommand = (args: readonly string[]) =>
  Command.run(benchCommand, { name: "probabench", version: "test" })([
    "node",
    "probabench",
    ...args,
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(Benchmark.Default, ResultsStore.Default, FetchHttpClient.layer).pipe(
        Layer.provideMerge(NodeContext.layer),
      ),
    ),
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
  );

describe("plan resolution", () => {
  it("counts both endpoints including nondivisor steps", () => {
    expect(xStepCount(10)).toBe(11);
    expect(xStepCount(30)).toBe(5);
    expect(xStepCount(100)).toBe(2);
  });
  it("expands aliases and projects provider attempts separately from samples", () => {
    const plan = resolvePlan(["all"], 5, 50);
    expect(plan.targets).toHaveLength(MODEL_ALIASES.length);
    expect(plan.projectedCalls).toBe(MODEL_ALIASES.length * 15);
    expect(describePlan(plan)).toContain(`Projected samples: ${plan.projectedCalls}`);
    expect(describePlan(plan)).toContain(
      `Provider attempts with retries: up to ${plan.projectedCalls * 6}`,
    );
  });
  it("resolves arbitrary models and an explicit reasoning override", () => {
    const plan = resolvePlan(["vendor/new-model"], 2, 30, "high");
    expect(plan.targets[0]?.id).toBe("vendor/new-model [reasoning=high]");
    expect(plan.projectedCalls).toBe(10);
  });
  it("matches the page's guided quick, standard, thorough and custom presets", () => {
    expect(TRIAL_PRESETS.map((preset) => preset.value)).toEqual([
      { trialsPerStep: 10, stepPercent: 25 },
      { trialsPerStep: 50, stepPercent: 10 },
      { trialsPerStep: 100, stepPercent: 5 },
      { trialsPerStep: 0, stepPercent: 0 },
    ]);
    expect(
      TRIAL_PRESETS.slice(0, 3).map(
        (preset) => preset.value.trialsPerStep * xStepCount(preset.value.stepPercent),
      ),
    ).toEqual([50, 550, 2100]);
  });
});

describe("confirmation", () => {
  it("proceeds with --yes and prompts in a terminal", () => {
    expect(Effect.runSync(confirmationGate(true, false))).toBe("proceed");
    expect(Effect.runSync(confirmationGate(false, true))).toBe("prompt");
    expect(Effect.runSync(Effect.flip(confirmationGate(false, false))).message).toBe(
      NON_TTY_MESSAGE,
    );
  });
});

describe("CLI validation", () => {
  for (const [option, value] of [
    ["step", "0"],
    ["step", "101"],
    ["step", "1.5"],
    ["trials", "-1"],
    ["trials", "9007199254740992"],
    ["concurrency", "0"],
    ["max-tokens", "0"],
    ["reasoning", "bogus"],
  ] as const) {
    it.effect(`rejects --${option} ${value} before dry run`, () =>
      Effect.gen(function* () {
        expect(
          Exit.isFailure(
            yield* Effect.exit(runCommand(["--model", "all", "--dry-run", `--${option}`, value])),
          ),
        ).toBe(true);
      }),
    );
  }
  it.effect("rejects unknown aliases mixed with valid models even with --yes", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(runCommand(["--model", "vendor/model,typo", "--yes"])))._tag).toBe(
        "InvalidOptions",
      );
    }),
  );
  it.effect("shows useful setup instructions with no model in a noninteractive terminal", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runCommand([]));
      expect(error._tag).toBe("InvalidOptions");
      expect("message" in error ? error.message : "").toBe(MISSING_MODEL_MESSAGE);
    }),
  );
  it.effect("requires --yes for explicit noninteractive execution", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(runCommand(["--model", "vendor/model"])))._tag).toBe(
        "NonInteractiveError",
      );
    }),
  );
  it.effect("lists aliases without credentials, models, or confirmation", () =>
    runCommand(["--list"]),
  );
  it.effect("dry-runs any OpenRouter slug without credentials or confirmation", () =>
    runCommand([
      "--model",
      "vendor/future-model:free",
      "--step",
      "30",
      "--trials",
      "2",
      "--reasoning",
      "low",
      "--dry-run",
    ]),
  );
});
