import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import { HISTORY_ROUTES, type Results } from "@probabench/domain";
import { makeRun } from "@probabench/domain/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import type { Database, Statement } from "../../../service/src/database";
import worker, { type Env } from "../../../service/src/worker";
import { executePlan } from "../cli/execute";
import type { BenchPlan } from "../plan/plan";
import { CloudHistory, cloudHistoryLayer } from "./cloud-history";
import { appendCheckpoints, withSharedHistory } from "./results-store";
import { readResults, withHistoryFile } from "./testing";

const { KEY } = vi.hoisted(() => ({ KEY: "test-history-secret-with-at-least-32-characters" }));
vi.mock("../../../stack/history-token", () => ({ readHistoryWriteToken: async () => KEY }));

/** Exercise D1's transaction semantics against SQLite, including constraint rollback. */
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../../../service/migrations/0001_history.sql", import.meta.url), "utf8"),
  );
  class Query implements Statement {
    constructor(
      readonly sql: string,
      readonly values: (string | number)[] = [],
    ) {}
    bind(...values: (string | number)[]) {
      return new Query(this.sql, values);
    }
    async run() {
      return sqlite.prepare(this.sql).run(...this.values);
    }
    async all<T>() {
      return { results: sqlite.prepare(this.sql).all(...this.values) as T[] };
    }
  }
  const db: Database = {
    prepare: (sql) => new Query(sql),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) {
          if (!(statement instanceof Query)) throw new Error("Unexpected statement");
          sqlite.prepare(statement.sql).run(...statement.values);
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const env: Env = {
    DB: db,
    HISTORY_WRITE_TOKEN: KEY,
    ASSETS: { fetch: async () => new Response("assets") },
  };
  return { sqlite, env };
}

const plan = (out: string, trialsPerStep = 1): BenchPlan => ({
  out,
  series: [{ model: "vendor/model", modelSlug: "vendor/model", reasoning: "off" }],
  options: { trialsPerStep, stepPercent: 100, concurrency: 1, maxTokens: 16 },
});

const config = ConfigProvider.fromMap(
  new Map([
    ["PROBABENCH_URL", "https://bench.test"],
    ["OPENROUTER_API_KEY", "sk-test"],
  ]),
);

function endpoint(env: Env) {
  let calls = 0;
  let loseAcknowledgment = false;
  let rejectUpload = false;
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.tryPromise({
        try: async () => {
          let response: Response;
          if (request.url.startsWith("https://openrouter.ai/")) {
            calls++;
            response = Response.json({ choices: [{ message: { content: "1" } }] });
          } else {
            const body =
              request.body._tag === "Uint8Array"
                ? new TextDecoder().decode(request.body.body)
                : undefined;
            const upload =
              request.method === "POST" &&
              new URL(request.url).pathname === HISTORY_ROUTES.checkpoints;
            response =
              upload && rejectUpload
                ? Response.json({ error: "Rejected" }, { status: 401 })
                : await worker.fetch(
                    new Request(request.url, {
                      method: request.method,
                      headers: request.headers,
                      ...(body === undefined ? {} : { body }),
                    }),
                    env,
                  );
            if (upload && response.ok && loseAcknowledgment) {
              loseAcknowledgment = false;
              response = Response.json({ error: "Acknowledgment lost" }, { status: 503 });
            }
          }
          return HttpClientResponse.fromWeb(request, response);
        },
        catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
      }),
    ),
  );
  return {
    layer,
    get calls() {
      return calls;
    },
    loseNextAcknowledgment: () => {
      loseAcknowledgment = true;
    },
    rejectUploads: (reject: boolean) => {
      rejectUpload = reject;
    },
  };
}

describe("shared Cloudflare history", () => {
  it.live("imports and paginates history, then resumes on a fresh machine", () => {
    const { sqlite, env } = database();
    const http = endpoint(env);
    const older = Array.from({ length: 130 }, () => makeRun({ points: [{ x: 0, outcomes: [0] }] }));
    return withHistoryFile((a) =>
      withHistoryFile((b) =>
        Effect.gen(function* () {
          yield* appendCheckpoints(a, older);
          yield* executePlan(plan(a));
          yield* executePlan(plan(b));
          expect(http.calls).toBe(2);
          const cloud = yield* CloudHistory;
          const history = yield* cloud.read;
          expect(history.runs).toHaveLength(132);
          expect(history.runs.slice(0, 130)).toEqual(older);
          expect((yield* readResults(b)).runs).toHaveLength(132);
          yield* executePlan(plan(b));
          expect(http.calls).toBe(2);
        }).pipe(
          Effect.provide(cloudHistoryLayer),
          Effect.provide(http.layer),
          Effect.withConfigProvider(config),
          Effect.ensuring(Effect.sync(() => sqlite.close())),
        ),
      ),
    );
  });

  it.live(
    "deduplicates a lost upload acknowledgment and recovers local answers after upload failure",
    () => {
      const { sqlite, env } = database();
      const http = endpoint(env);
      return withHistoryFile((path) =>
        Effect.gen(function* () {
          http.loseNextAcknowledgment();
          yield* executePlan(plan(path));
          expect(http.calls).toBe(2);
          http.rejectUploads(true);
          yield* Effect.flip(executePlan(plan(path, 2)));
          const local = yield* readResults(path);
          const count = (history: Results) =>
            history.runs.reduce(
              (total, record) =>
                total + record.points.reduce((n, point) => n + point.outcomes.length, 0),
              0,
            );
          expect(count(local)).toBe(3);
          const cloud = yield* CloudHistory;
          expect(count(yield* cloud.read)).toBe(2);
          http.rejectUploads(false);
          yield* executePlan(plan(path, 2));
          expect(http.calls).toBe(4);
          expect(count(yield* cloud.read)).toBe(4);
          expect((yield* readResults(path)).runs).toEqual((yield* cloud.read).runs);
          yield* withSharedHistory(path, () => Effect.void);
          expect(http.calls).toBe(4);
        }).pipe(
          Effect.provide(cloudHistoryLayer),
          Effect.provide(http.layer),
          Effect.withConfigProvider(config),
          Effect.ensuring(Effect.sync(() => sqlite.close())),
        ),
      );
    },
  );
});
