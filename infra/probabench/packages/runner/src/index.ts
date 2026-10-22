#!/usr/bin/env bun
// @probabench/runner — Bun CLI: Effect services, @effect/ai provider layers,
// orchestration, and results writing. This module doubles as the package barrel
// and, when executed directly (the `probabench` bin), the runMain entry point.

import { pathToFileURL } from "node:url";
import * as Command from "@effect/cli/Command";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Results } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Benchmark } from "./benchmark";
import { benchCommand } from "./cli";
import { ResultsStore } from "./results-store";

export const RUNNER_PACKAGE = "@probabench/runner" as const;
export const RESULTS_SCHEMA = Results;

export * from "./benchmark";
export * from "./bit-sampler";
export * from "./cli";
export * from "./openrouter";
export * from "./options";
export * from "./registry";
export * from "./results-store";
export * from "./retry";
export * from "./run";

/**
 * The platform and service environment at the CLI edge: Node's FileSystem/Path/Terminal
 * (the CLI runtime and ResultsStore), an HTTP client, and Benchmark/ResultsStore.
 * OpenRouter credentials are required only when a nonempty confirmed plan executes;
 * guided setup, listing aliases, and dry runs remain entirely local.
 */
const MainLive = Layer.mergeAll(Benchmark.Default, ResultsStore.Default, NodeHttpClient.layer).pipe(
  Layer.provideMerge(NodeContext.layer),
);

const cli = Command.run(benchCommand, { name: "probabench", version: "0.0.0" });

/** The CLI program: parse argv, run the resolved plan, and provide the Node environment. */
export const main = cli(process.argv).pipe(Effect.provide(MainLive));

// Run as the bin entry point; importing this module as the package barrel has no side effect.
const entryUrl = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entryUrl === import.meta.url) {
  NodeRuntime.runMain(main);
}
