// Terminal frames and piped summaries observe the same durable sample counters.
// Rendering runs on a timer, never on the request or checkpoint path.
import { stripVTControlCharacters } from "node:util";
import { formatSampleProgress } from "@probabench/domain";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type { DailyPlan, DailySeries } from "../plan/daily";
import { type SamplingObserver, SamplingProgress, type SchedulerStatus } from "./observer";

interface ModelProgress {
  readonly entry: DailySeries;
  saved: number;
  active: number;
  retries: number;
  invalid: number;
  finished: boolean;
  error: string | undefined;
}

const count = (n: number): string => n.toLocaleString("en-US");
const duration = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor(total / 60) % 60}m`;
};
const clip = (value: string, width: number): string => {
  if (value.length <= width) return value;
  if (width < 3) return value.slice(0, width);
  const head = Math.ceil((width - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-(width - head - 1))}`;
};

export const withProgressDisplay = <A, E, R>(
  daily: DailyPlan,
  maximum: number,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const clock = yield* Clock.clockWith(Effect.succeed);
      const startedAt = clock.unsafeCurrentTimeMillis();
      const terminal =
        process.stderr.isTTY === true &&
        process.stdout.isTTY === true &&
        process.env.TERM !== "dumb";
      const models: ModelProgress[] = daily.series.map((entry) => ({
        entry,
        saved: 0,
        active: 0,
        retries: 0,
        invalid: 0,
        finished: entry.remaining === 0,
        error: undefined,
      }));
      const byModel = new Map(models.map((model) => [model.entry.series.model, model]));
      let scheduler = (): SchedulerStatus => ({
        active: 0,
        limit: Math.min(8, maximum),
        blockedUntil: 0,
        models: new Map(),
      });
      let lastSavedAt: number | undefined;
      let drawnLines = 0;
      let lastDetailsAt = -Infinity;
      const reported = new Set<string>();
      const reportedErrors = new Set<string>();

      const observer: SamplingObserver = {
        scheduler: (read) => {
          scheduler = read;
        },
        started: (key, retry) => {
          const model = byModel.get(key);
          if (model) {
            model.active++;
            if (retry) model.retries++;
          }
        },
        ended: (key) => {
          const model = byModel.get(key);
          if (model) model.active--;
        },
        saved: (key, invalid) => {
          const model = byModel.get(key);
          if (!model) return;
          model.saved++;
          if (invalid) model.invalid++;
          lastSavedAt = clock.unsafeCurrentTimeMillis();
        },
        finished: (key, error) => {
          const model = byModel.get(key);
          if (model) {
            model.finished = true;
            model.error = error;
          }
        },
      };

      const render = (outcome?: "Complete" | "Stopped" | "Interrupted") =>
        Effect.gen(function* () {
          const now = clock.unsafeCurrentTimeMillis();
          const elapsed = Math.max(0, (now - startedAt) / 1000);
          const admission = scheduler();
          const blocked = admission.blockedUntil > now;
          let saved = 0,
            retries = 0,
            invalid = 0,
            rate = 0,
            eta = 0;
          let canEstimate = elapsed >= 30;
          const states = new Map<ModelProgress, string>();
          for (const model of models) {
            // Wall-clock throughput includes queueing and cooldowns. A shorter
            // rolling window goes empty during normal 120-second backoffs.
            const modelRate = model.saved / Math.max(1, elapsed);
            saved += model.saved;
            retries += model.retries;
            invalid += model.invalid;
            rate += modelRate;
            const own = admission.models.get(model.entry.series.modelSlug);
            const remaining = model.entry.remaining - model.saved;
            const paused = (own?.blockedUntil ?? 0) > now;
            if (model.error !== undefined) canEstimate = false;
            if (!model.finished && remaining > 0) {
              if (model.saved < 5 || modelRate === 0) canEstimate = false;
              else {
                const waitSeconds =
                  remaining > model.active
                    ? Math.max(0, admission.blockedUntil - now, (own?.blockedUntil ?? 0) - now) /
                      1000
                    : 0;
                eta = Math.max(eta, remaining / modelRate, waitSeconds);
              }
            }
            const state =
              model.error !== undefined
                ? "Failed"
                : model.entry.remaining === 0
                  ? "Up to date"
                  : remaining === 0
                    ? "Done"
                    : outcome
                      ? "Stopped"
                      : paused
                        ? model.active > 0
                          ? "Draining"
                          : `Cooldown ${duration(((own?.blockedUntil ?? now) - now) / 1000)}`
                        : blocked
                          ? model.active > 0
                            ? "Draining"
                            : "Account cooldown"
                          : model.active > 0
                            ? "Sampling"
                            : (own?.queued ?? 0) > 0
                              ? "Queued"
                              : model.retries > 0
                                ? "Retry waiting"
                                : "Starting";
            states.set(model, state);
          }
          const percent = daily.remaining === 0 ? 100 : (saved / daily.remaining) * 100;
          const etaText = canEstimate && eta > 0 && !outcome ? `~${duration(eta)}` : "--";
          const wait = blocked
            ? `OpenRouter cooldown ${duration((admission.blockedUntil - now) / 1000)}`
            : "";
          const last =
            lastSavedAt === undefined
              ? "No answers saved yet"
              : `Last save ${duration(Math.floor((now - lastSavedAt) / 1000))} ago`;
          const stats = `${rate.toFixed(1)}/s avg  Elapsed ${duration(Math.floor(elapsed))}  ETA ${etaText}`;

          if (terminal) {
            const width = Math.max(20, (process.stderr.columns || 80) - 1);
            const height = process.stderr.rows || 24;
            const failures = models.filter((model) => model.error !== undefined);
            const slots = Math.max(1, height - 9 - Math.min(1, failures.length));
            const page = outcome ? 0 : Math.floor(elapsed / 10) % Math.ceil(models.length / slots);
            const visible = outcome ? models : models.slice(page * slots, (page + 1) * slots);
            const tallyWidth = Math.max(
              9,
              ...models.map(
                (model) => `${count(model.entry.remaining)}/${count(model.entry.remaining)}`.length,
              ),
            );
            const narrow = width < 65;
            const nameWidth = Math.max(8, width - tallyWidth - (narrow ? 17 : 37));
            const row = (
              name: string,
              tally: string,
              active: string,
              retry: string,
              state: string,
            ) =>
              narrow
                ? `${clip(name, nameWidth).padEnd(nameWidth)}  ${tally.padStart(tallyWidth)}  ${clip(state, 13)}`
                : `${name.padEnd(nameWidth)}  ${tally.padStart(tallyWidth)}  ${active.padStart(6)}  ${retry.padStart(6)}  ${state}`;
            const barWidth = Math.max(4, Math.min(24, width - 48));
            const filled = Math.floor(barWidth * Math.min(1, percent / 100));
            const lines = [
              `${outcome ?? "Sampling"} ${percent.toFixed(1)}%  ${count(saved)}/${count(daily.remaining)} saved${width >= 65 ? ` [${"#".repeat(filled)}${"-".repeat(barWidth - filled)}]` : ""}`,
              stats,
              `Active ${admission.active}  Limit ${admission.limit}  Retries ${count(retries)}  Invalid ${count(invalid)}`,
              [wait, last].filter(Boolean).join("  "),
              "",
              row("Model", "Saved", "Active", "Retry", "State"),
              ...visible.map((model) => {
                const mode = narrow ? "" : ` (${model.entry.series.reasoning})`;
                const name =
                  clip(model.entry.series.modelSlug, Math.max(1, nameWidth - mode.length)) + mode;
                return row(
                  name,
                  `${count(model.saved)}/${count(model.entry.remaining)}`,
                  String(model.active),
                  String(model.retries),
                  states.get(model) ?? "",
                );
              }),
              ...(visible.length < models.length
                ? [
                    `Models ${page * slots + 1}–${Math.min((page + 1) * slots, models.length)} of ${models.length}; rotates every 10s`,
                  ]
                : []),
              ...(failures[0]
                ? [
                    `${failures.length} failed: ${failures[0].entry.series.modelSlug} — ${stripVTControlCharacters(failures[0].error ?? "").split("\n")[0]}`,
                  ]
                : []),
            ].map((line) => line.slice(0, width));
            if (drawnLines > 0) process.stderr.write(`\x1b[${drawnLines}A\r\x1b[0J`);
            process.stderr.write(`${lines.join("\n")}\n`);
            drawnLines = lines.length;
          } else {
            const details = now - lastDetailsAt >= 60_000 || outcome !== undefined;
            const lines = [
              `${formatSampleProgress({ completed: saved, total: daily.remaining })} (${percent.toFixed(1)}%)  ${stats}  Active ${admission.active}  Limit ${admission.limit}  Retries ${retries}  Invalid ${invalid}${wait ? `  ${wait}` : ""}${outcome ? `  ${outcome}` : ""}`,
            ];
            for (const model of models) {
              const key = model.entry.series.model;
              const finished = model.finished && !reported.has(key);
              if (details || finished) {
                lines.push(
                  `[${key}] ${model.saved}/${model.entry.remaining} saved  ${model.active} active  ${model.retries} retries  ${states.get(model)}`,
                );
                if (model.finished) reported.add(key);
              }
            }
            if (details) lastDetailsAt = now;
            yield* Console.log(lines.join("\n"));
          }
          for (const model of models) {
            const key = model.entry.series.model;
            if (model.error !== undefined && (!terminal || outcome) && !reportedErrors.has(key)) {
              reportedErrors.add(key);
              yield* Console.error(`[${key}] ${stripVTControlCharacters(model.error)}`);
            }
          }
        });

      yield* render();
      const timer = yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(terminal ? "250 millis" : "10 seconds").pipe(Effect.andThen(render())),
        ),
      );
      return yield* work.pipe(
        Effect.provideService(SamplingProgress, observer),
        Effect.onExit((exit) =>
          Fiber.interrupt(timer).pipe(
            Effect.andThen(
              render(
                Exit.isSuccess(exit)
                  ? "Complete"
                  : Cause.isInterruptedOnly(exit.cause)
                    ? "Interrupted"
                    : "Stopped",
              ),
            ),
          ),
        ),
      );
    }),
  );
