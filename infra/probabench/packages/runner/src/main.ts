// probabench CLI entry: provides the Node platform and runs the bench command.
import * as Command from "@effect/cli/Command";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { benchCommand } from "./cli/command";
import { ResultsStore } from "./store/results-store";

/**
 * Node's FileSystem, Path and Terminal for the CLI and the store, and an HTTP client
 * for OpenRouter. Listing aliases, guided setup and dry runs never read the key.
 */
const MainLive = Layer.mergeAll(ResultsStore.Default, NodeHttpClient.layer).pipe(
  Layer.provideMerge(NodeContext.layer),
);

NodeRuntime.runMain(
  Command.run(benchCommand, { name: "probabench", version: "0.0.0" })(process.argv).pipe(
    Effect.provide(MainLive),
  ),
);
