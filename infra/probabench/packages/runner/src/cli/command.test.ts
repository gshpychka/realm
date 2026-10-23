import { existsSync } from "node:fs";
import * as HelpDoc from "@effect/cli/HelpDoc";
import * as ValidationError from "@effect/cli/ValidationError";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as NodeContext from "@effect/platform-node/NodeContext";
import { describe, expect, it } from "@effect/vitest";
import { benchArgs } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { withApiKey } from "../sampling/testing";
import { cli, HISTORY_PATH } from "./command";

// Vitest's stdin is not a TTY, so these cover the non-interactive path.
const runCommand = (args: readonly string[]) =>
  cli(["node", "probabench", ...args]).pipe(
    Effect.provide(Layer.merge(NodeContext.layer, FetchHttpClient.layer)),
    withApiKey(),
  );

/** What a failing command reports: a flag's validation text or an error's message. */
const failureText = (args: readonly string[]) =>
  Effect.flip(runCommand(args)).pipe(
    Effect.map((error) =>
      ValidationError.isValidationError(error) ? HelpDoc.toAnsiText(error.error) : error.message,
    ),
  );

describe("probabench command", () => {
  it.effect("dry-runs every alias without credentials", () =>
    runCommand(["--model", "all", "--dry-run"]),
  );

  // Parse failures are @effect/cli's own text, so those rows match a short substring.
  it.effect.each([
    ["step", "0", "--step must be from 1 to 100."],
    ["step", "101", "--step must be from 1 to 100."],
    ["step", "1.5", "integer"],
    ["trials", "-1", "--trials must be a positive integer."],
    ["trials", "9007199254740992", "integer"],
    ["concurrency", "0", "--concurrency must be a positive integer."],
    ["max-tokens", "0", "--max-tokens must be a positive integer."],
    ["reasoning", "bogus", "Expected one of the following cases"],
  ] as const)("rejects --%s %j before planning", ([flag, value, expected]) =>
    Effect.gen(function* () {
      expect(yield* failureText(["--model", "all", "--dry-run", `--${flag}`, value])).toContain(
        expected,
      );
    }),
  );

  it.effect("rejects unknown models mixed with valid ones, even with --yes", () =>
    Effect.gen(function* () {
      expect(yield* failureText(["--model", "vendor/model,typo", "--yes"])).toBe(
        "Unknown models: typo. Use --list or an OpenRouter model ID (vendor/model).",
      );
    }),
  );

  it.effect("asks for a model when none is given", () =>
    Effect.gen(function* () {
      expect(yield* failureText([])).toContain("--model");
    }),
  );

  it.effect("requires --yes to run without a terminal to confirm in", () =>
    Effect.gen(function* () {
      expect(yield* failureText(["--model", "vendor/model"])).toContain("--yes");
    }),
  );

  it("writes to the workspace's tracked history", () => {
    expect(existsSync(HISTORY_PATH)).toBe(true);
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
