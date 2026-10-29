// One admission queue for the whole benchmark. OpenRouter has no published paid-model
// concurrency ceiling: discover capacity with slow start, then additive increase /
// multiplicative decrease. Provider throttles affect one model; gateway limits and
// temporary spending holds affect the account. Waiting and retries hold no permits.
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { inFlightBudgetLimited, type ProviderFailure, providerDelayMillis } from "./retry";

interface Window {
  readonly name: string;
  active: number;
  limit: number;
  threshold: number;
  successes: number;
  generation: number;
  strikes: number;
  blockedUntil: number;
}

interface Lease {
  readonly windows: readonly { window: Window; generation: number }[];
  released: boolean;
}

interface Ticket {
  readonly resume: (effect: Effect.Effect<Lease>) => void;
  lease?: Lease;
}

interface ModelQueue {
  readonly windows: readonly Window[];
  readonly pending: Ticket[];
}

export class RequestScheduler extends Context.Tag("probabench/RequestScheduler")<
  RequestScheduler,
  {
    readonly request: <A, R>(
      model: string,
      attempt: Effect.Effect<A, ProviderFailure, R>,
    ) => Effect.Effect<A, ProviderFailure, R>;
  }
>() {}

const makeScheduler = (maximum: number) =>
  Effect.gen(function* () {
    const clock = yield* Clock.clockWith(Effect.succeed);
    // Coalesce wakeups. One dispatcher and one timer serve every waiting sample.
    const wake = yield* Queue.sliding<void>(1);
    const window = (name: string, initial: number): Window => ({
      name,
      active: 0,
      limit: Math.min(initial, maximum),
      threshold: Infinity,
      successes: 0,
      generation: 0,
      strikes: 0,
      blockedUntil: 0,
    });
    const account = window("OpenRouter", 8);
    const free = window("OpenRouter free models", 2);
    const models = new Map<string, ModelQueue>();
    const queues: ModelQueue[] = [];
    let cursor = 0;

    const notify = () => {
      wake.unsafeOffer(undefined);
    };
    const release = (lease: Lease) => {
      if (lease.released) return;
      lease.released = true;
      for (const { window } of lease.windows) window.active--;
      notify();
    };
    const modelQueue = (model: string) => {
      const existing = models.get(model);
      if (existing) return existing;
      const queue: ModelQueue = {
        windows: [account, ...(model.endsWith(":free") ? [free] : []), window(model, 4)],
        pending: [],
      };
      models.set(model, queue);
      queues.push(queue);
      return queue;
    };

    // Round-robin across model IDs, including different reasoning modes of one ID.
    // A sleeping model never prevents another model from taking available capacity.
    const pump = (): number => {
      const now = clock.unsafeCurrentTimeMillis();
      let idle = 0;
      while (queues.length > 0 && idle < queues.length) {
        const queue = queues[cursor % queues.length];
        cursor = (cursor + 1) % queues.length;
        if (
          !queue ||
          queue.pending.length === 0 ||
          queue.windows.some((w) => w.active >= w.limit || w.blockedUntil > now)
        ) {
          idle++;
          continue;
        }
        const ticket = queue.pending.shift();
        if (!ticket) continue;
        const lease: Lease = {
          windows: queue.windows.map((w) => {
            w.active++;
            return { window: w, generation: w.generation };
          }),
          released: false,
        };
        ticket.lease = lease;
        ticket.resume(Effect.succeed(lease));
        idle = 0;
      }
      let deadline = Infinity;
      for (const queue of queues) {
        if (queue.pending.length === 0 || queue.windows.some((w) => w.active >= w.limit)) continue;
        const readyAt = Math.max(...queue.windows.map((w) => w.blockedUntil));
        if (readyAt > now) deadline = Math.min(deadline, readyAt);
      }
      return deadline;
    };

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.suspend(() => {
          const deadline = pump();
          return Number.isFinite(deadline)
            ? Effect.raceFirst(
                Queue.take(wake),
                Effect.sleep(Math.max(0, deadline - clock.unsafeCurrentTimeMillis())),
              )
            : Queue.take(wake);
        }),
      ),
    );

    const acquire = (model: string) =>
      Effect.async<Lease>((resume) => {
        const queue = modelQueue(model);
        const ticket: Ticket = { resume };
        queue.pending.push(ticket);
        notify();
        return Effect.sync(() => {
          if (ticket.lease) release(ticket.lease);
          else {
            const index = queue.pending.indexOf(ticket);
            if (index >= 0) queue.pending.splice(index, 1);
          }
        });
      });

    const success = (lease: Lease) =>
      Effect.sync(() => {
        for (const { window: w, generation } of lease.windows) {
          // Replies already in flight when a limit was hit cannot undo the reduction.
          if (generation !== w.generation) continue;
          w.strikes = 0;
          w.successes++;
          if (w.limit < maximum && (w.limit < w.threshold || w.successes >= w.limit)) {
            w.limit++;
            w.successes = 0;
          }
        }
      });

    const failure = (model: string, lease: Lease, error: ProviderFailure) =>
      Effect.gen(function* () {
        if (error._tag !== "HttpResponseError") return;
        const { status, headers } = error.response;
        const budget = inFlightBudgetLimited(error);
        if (status !== 429 && status !== 503 && !budget) return;
        const gateway = status === 429 && headers["x-ratelimit-limit"] !== undefined;
        const affected =
          budget || (gateway && !model.endsWith(":free"))
            ? account
            : gateway
              ? free
              : lease.windows[lease.windows.length - 1]?.window;
        if (!affected) return;
        const version = lease.windows.find(({ window }) => window === affected)?.generation;
        const now = clock.unsafeCurrentTimeMillis();
        const fresh = version === affected.generation;
        if (fresh) {
          affected.limit = Math.max(1, Math.floor(affected.limit / 2));
          affected.threshold = affected.limit;
          affected.successes = 0;
          affected.generation++;
          affected.strikes++;
        }
        const delay = Math.max(
          providerDelayMillis(error, now),
          Math.min(60_000, 1000 * 2 ** (affected.strikes - 1)),
        );
        affected.blockedUntil = Math.max(affected.blockedUntil, now + delay);
        if (fresh)
          yield* Console.log(
            `[${affected.name}] throttled; waiting ${Math.ceil(delay / 1000)}s, concurrency ${affected.limit}`,
          );
      });

    return RequestScheduler.of({
      request: (model, attempt) =>
        Effect.uninterruptibleMask((restore) =>
          restore(acquire(model)).pipe(
            Effect.flatMap((lease) =>
              restore(attempt).pipe(
                Effect.tapBoth({
                  onFailure: (error) => failure(model, lease, error),
                  onSuccess: () => success(lease),
                }),
                Effect.ensuring(Effect.sync(() => release(lease))),
              ),
            ),
          ),
        ),
    });
  });

export const schedulerLayer = (maximum: number) =>
  Layer.scoped(RequestScheduler, makeScheduler(maximum));
