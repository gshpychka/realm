import * as AiError from "@effect/ai/AiError";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/TestClock";
import { withProviderRetry } from "./retry";
import { RequestScheduler, schedulerLayer } from "./scheduler";

const failure = (status: number, headers: Record<string, string> = {}) =>
  new AiError.HttpResponseError({
    module: "OpenRouterClient",
    method: "createChatCompletion",
    reason: "StatusCode",
    request: {
      method: "POST",
      url: "https://openrouter.ai/api/v1/chat/completions",
      urlParams: [],
      hash: Option.none(),
      headers: {},
    },
    response: { status, headers },
  });

describe("adaptive request scheduler", () => {
  it.effect("completes a throttled workload while another model keeps moving", () =>
    Effect.gen(function* () {
      const scheduler = yield* RequestScheduler;
      const active = new Map<string, number>();
      const completed = new Map<string, number>();
      let throttles = 0;
      const tasks = Array.from({ length: 80 }, (_, i) => ({
        i,
        model: i % 2 === 0 ? "vendor/limited" : "vendor/healthy",
      }));
      const fiber = yield* Effect.fork(
        Effect.forEach(
          tasks,
          ({ i, model }) =>
            withProviderRetry(
              scheduler.request(
                model,
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    const count = (active.get(model) ?? 0) + 1;
                    active.set(model, count);
                    return count;
                  }),
                  (count) => {
                    if (model === "vendor/limited" && count > 3) {
                      throttles++;
                      return Effect.fail(failure(429, { "retry-after": "2" }));
                    }
                    return Effect.sleep("100 millis").pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          completed.set(model, (completed.get(model) ?? 0) + 1);
                          return i;
                        }),
                      ),
                    );
                  },
                  () =>
                    Effect.sync(() => {
                      active.set(model, (active.get(model) ?? 0) - 1);
                    }),
                ),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      );
      yield* TestClock.adjust("1 second");
      expect(throttles).toBeGreaterThan(0);
      expect(completed.get("vendor/healthy")).toBe(40);
      expect(completed.get("vendor/limited") ?? 0).toBeLessThan(40);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Fiber.join(fiber)).toEqual(tasks.map(({ i }) => i));
      expect(completed.get("vendor/limited")).toBe(40);
      expect([...active.values()]).toEqual([0, 0]);
    }).pipe(Effect.provide(schedulerLayer(32))),
  );

  it.effect("releases permits during retry waits", () =>
    Effect.gen(function* () {
      const scheduler = yield* RequestScheduler;
      let attempts = 0;
      const retry = yield* Effect.fork(
        withProviderRetry(
          scheduler.request(
            "vendor/a",
            Effect.suspend(() =>
              ++attempts === 1
                ? Effect.fail(failure(429, { "retry-after": "30" }))
                : Effect.succeed("a"),
            ),
          ),
        ),
      );
      yield* TestClock.adjust(0);
      expect(yield* scheduler.request("vendor/b", Effect.succeed("b"))).toBe("b");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(retry)).toBe("a");
      expect(attempts).toBe(2);
    }).pipe(Effect.provide(schedulerLayer(1))),
  );

  it.effect("cancels queued and active requests without leaking permits", () =>
    Effect.gen(function* () {
      const scheduler = yield* RequestScheduler;
      const started = yield* Deferred.make<void>();
      let cancelledStarted = false;
      const active = yield* Effect.fork(
        scheduler.request(
          "vendor/a",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* Deferred.await(started);
      const queued = yield* Effect.fork(
        scheduler.request(
          "vendor/b",
          Effect.sync(() => {
            cancelledStarted = true;
          }),
        ),
      );
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(queued);
      yield* Fiber.interrupt(active);
      expect(yield* scheduler.request("vendor/b", Effect.succeed("available"))).toBe("available");
      expect(cancelledStarted).toBe(false);
    }).pipe(Effect.provide(schedulerLayer(1))),
  );
});
