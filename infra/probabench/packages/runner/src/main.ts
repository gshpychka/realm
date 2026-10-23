// probabench CLI entry: provides the Node platform and runs the bench command.
import * as Command from "@effect/cli/Command";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Benchmark } from "./benchmark";
import { benchCommand } from "./cli";
import { ResultsStore } from "./results-store";

/**
 * The platform and service environment at the CLI edge: Node's FileSystem/Path/Terminal
 * (the CLI runtime and ResultsStore), an HTTP client, and Benchmark/ResultsStore.
 * OpenRouter credentials are required only when a nonempty confirmed plan executes;
 * guided setup, listing aliases, and dry runs remain entirely local.
 */
const MainLive = Layer.mergeAll(Benchmark.Default, ResultsStore.Default, NodeHttpClient.layer).pipe(
  Layer.provideMerge(NodeContext.layer),
);

NodeRuntime.runMain(
  Command.run(benchCommand, { name: "probabench", version: "0.0.0" })(process.argv).pipe(
    Effect.provide(MainLive),
  ),
);
