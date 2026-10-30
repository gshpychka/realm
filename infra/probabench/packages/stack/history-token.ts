import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";

export const STACK_NAME = "ProbaBench";

/** Read the deployed upload credential from encrypted Alchemy state. */
export const readHistoryWriteToken = (): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Alchemist.State.store({ backend: "cloudflare" });
      const output = yield* store.getOutput({ stack: STACK_NAME, stage: "prod" });
      if (
        typeof output !== "object" ||
        output === null ||
        !("writeToken" in output) ||
        !Redacted.isRedacted(output.writeToken)
      )
        return yield* Effect.fail(new Error("Deploy ProbaBench before sampling."));
      const token = Redacted.value(output.writeToken);
      if (typeof token !== "string" || token.length < 32)
        return yield* Effect.fail(new Error("Invalid ProbaBench upload credential."));
      return token;
    }).pipe(
      Effect.provide(Alchemist.layer()),
      Effect.scoped,
      Effect.catchCause(() =>
        Effect.fail(
          new Error(
            "Could not read the upload credential from Alchemy state. Deploy ProbaBench and load the Cloudflare credentials through SOPS.",
          ),
        ),
      ),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    ),
  );
