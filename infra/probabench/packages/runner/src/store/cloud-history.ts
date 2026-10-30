// Cloudflare is authoritative. The local file is an append-only recovery copy.
import * as HttpBody from "@effect/platform/HttpBody";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { HISTORY_ROUTES, HistoryPage, type Results, type Run } from "@probabench/domain";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

export class CloudHistoryError extends Data.TaggedError("CloudHistoryError")<{
  readonly message: string;
  readonly status?: number;
}> {}

export class CloudHistory extends Context.Tag("probabench/CloudHistory")<
  CloudHistory,
  {
    readonly read: Effect.Effect<Results, CloudHistoryError>;
    readonly page: (after: number) => Effect.Effect<typeof HistoryPage.Type, CloudHistoryError>;
    readonly checkWrite: Effect.Effect<void, CloudHistoryError>;
    readonly append: (runs: readonly Run[]) => Effect.Effect<void, CloudHistoryError>;
  }
>() {}

const configurationError = (message: string) => new CloudHistoryError({ message });

/** Configuration is resolved when a history operation needs it. */
export const cloudHistoryLayer = Layer.effect(
  CloudHistory,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const origin = Config.string("PROBABENCH_URL").pipe(
      Config.orElse(() =>
        Config.nonEmptyString("DOMAIN_NAME").pipe(
          Config.map((domain) => `https://probabench.${domain}`),
        ),
      ),
      Effect.mapError(() =>
        configurationError(
          "Set PROBABENCH_URL to the deployed site, or use nix develop .#infra, which sets DOMAIN_NAME.",
        ),
      ),
      Effect.flatMap((value) =>
        Effect.try({
          try: () => {
            const url = new URL(value);
            const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
            if (
              (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash
            )
              throw new Error("Invalid origin");
            return url.origin;
          },
          catch: () =>
            configurationError(
              "PROBABENCH_URL must be an HTTPS origin (HTTP is allowed for localhost).",
            ),
        }),
      ),
    );
    const request = (
      path: string,
      method: "GET" | "HEAD" | "POST",
      body?: unknown,
      key?: Redacted.Redacted<string>,
    ) =>
      Effect.gen(function* () {
        const base = yield* origin;
        let req = HttpClientRequest.make(method)(`${base}${path}`);
        if (body !== undefined) req = HttpClientRequest.setBody(req, HttpBody.unsafeJson(body));
        if (key) req = HttpClientRequest.bearerToken(req, key);
        const response = yield* client.execute(req);
        if (response.status < 200 || response.status >= 300)
          return yield* new CloudHistoryError({
            status: response.status,
            message: `Cloudflare history returned HTTP ${response.status}. ${response.status === 401 ? "Check that the runner and deployed site use the same Alchemy stack and Cloudflare account." : "Sampling stopped; locally saved answers will upload on the next invocation."}`,
          });
        return response;
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((error) =>
          error instanceof CloudHistoryError
            ? error
            : configurationError(
                "Could not reach Cloudflare history. Sampling stopped; local answers are preserved for the next invocation.",
              ),
        ),
      );
    const retry = <A, R>(operation: Effect.Effect<A, CloudHistoryError, R>) =>
      operation.pipe(
        Effect.retry({
          schedule: Schedule.exponential("250 millis").pipe(Schedule.intersect(Schedule.recurs(3))),
          while: (error) =>
            error.status === undefined || error.status === 429 || error.status >= 500,
        }),
      );
    const page = (after: number) =>
      retry(
        request(`${HISTORY_ROUTES.results}?after=${after}`, "GET").pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(HistoryPage)),
          Effect.mapError((error) =>
            error instanceof CloudHistoryError
              ? error
              : configurationError("Cloudflare returned invalid benchmark history."),
          ),
          Effect.timeoutFail({
            duration: "15 seconds",
            onTimeout: () => configurationError("Cloudflare history read timed out."),
          }),
          Effect.scoped,
        ),
      );
    const read = Effect.gen(function* () {
      const runs: Run[] = [];
      let after = 0;
      for (;;) {
        const result = yield* page(after);
        runs.push(...result.runs);
        if (result.next === null) break;
        if (result.next <= after)
          return yield* configurationError("Cloudflare returned a non-advancing history cursor.");
        after = result.next;
      }
      return { runs };
    });
    const writeKey = yield* Effect.cached(
      Effect.tryPromise({
        try: async () => {
          const { readHistoryWriteToken } = await import("../../../stack/history-token");
          return Redacted.make(await readHistoryWriteToken());
        },
        catch: () =>
          configurationError(
            "Could not read the upload credential from Alchemy state. Deploy ProbaBench and load the Cloudflare credentials through SOPS.",
          ),
      }),
    );
    const checkWrite = Effect.flatMap(writeKey, (key) =>
      retry(
        request(HISTORY_ROUTES.checkpoints, "HEAD", undefined, key).pipe(
          Effect.asVoid,
          Effect.scoped,
        ),
      ),
    );
    const append = (runs: readonly Run[]) =>
      Effect.gen(function* () {
        if (runs.length === 0) return;
        const key = yield* writeKey;
        const upload = (batch: readonly Run[]) =>
          retry(
            request(HISTORY_ROUTES.checkpoints, "POST", { runs: batch }, key).pipe(
              Effect.asVoid,
              Effect.scoped,
            ),
          );
        // Bounded batches also handle uploading old, fully collected sweeps.
        let batch: Run[] = [];
        let bytes = 0;
        for (const run of runs) {
          const size = Buffer.byteLength(JSON.stringify(run));
          if (batch.length > 0 && (batch.length === 32 || bytes + size > 800_000)) {
            yield* upload(batch);
            batch = [];
            bytes = 0;
          }
          batch.push(run);
          bytes += size;
        }
        if (batch.length > 0) yield* upload(batch);
      });
    return CloudHistory.of({ read, page, checkWrite, append });
  }),
);
