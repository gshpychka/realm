// probabench CLI entry: provides the Node platform and runs the bench command.
import * as ValidationError from "@effect/cli/ValidationError";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { cli } from "./cli/command";

/**
 * Node's FileSystem, Path and Terminal for the CLI and the history file, and an HTTP
 * client for OpenRouter. Listing aliases and dry runs never read the key.
 */
const MainLive = Layer.merge(NodeContext.layer, NodeHttpClient.layer);

NodeRuntime.runMain(
  cli(process.argv).pipe(
    // @effect/cli has already printed a ValidationError with its help; every other
    // failure is expected and printed as its message. Defects keep the full log.
    Effect.tapError((error) =>
      ValidationError.isValidationError(error) ? Effect.void : Console.error(error.message),
    ),
    Effect.tapDefect(Effect.logError),
    Effect.provide(MainLive),
  ),
  {
    disableErrorReporting: true,
    // An interrupted benchmark (Ctrl-C, or the dev bridge's SIGTERM) exits 130 rather
    // than runMain's default 0.
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) ? 0 : Cause.isInterruptedOnly(exit.cause) ? 130 : 1),
  },
);
