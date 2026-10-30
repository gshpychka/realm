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
  cost: number;
  pricedReplies: number;
  missingCosts: number;
  finished: boolean;
  error: string | undefined;
}

const count = (n: number): string => n.toLocaleString("en-US");
const dollars = (cost: number): string =>
  cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const spent = (cost: number, missing: number): string =>
  missing > 0 ? (cost === 0 ? "--" : `≥${dollars(cost)}`) : dollars(cost);
const projectedCost = (model: ModelProgress): number | null => {
  const requests = model.entry.remaining;
  if (requests === 0 || (model.pricedReplies === requests && model.missingCosts === 0))
    return model.cost;
  return model.pricedReplies >= 5 ? (model.cost * requests) / model.pricedReplies : null;
};
const estimated = (cost: number | null) => (cost === null ? "--" : dollars(cost));
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
        cost: 0,
        pricedReplies: 0,
        missingCosts: 0,
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
        received: (key, cost) => {
          const model = byModel.get(key);
          if (!model) return;
          if (cost === null) model.missingCosts++;
          else {
            model.cost += cost;
            model.pricedReplies++;
          }
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
            cost = 0,
            missingCosts = 0,
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
            cost += model.cost;
            missingCosts += model.missingCosts;
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
          const costText = `Cost ${spent(cost, missingCosts)}`;
          const projections = models.map(projectedCost);
          const projectedTotal = projections.every((value) => value !== null)
            ? projections.reduce<number>((sum, value) => sum + (value ?? 0), 0)
            : null;
          const forecastText = `Est. total ${estimated(projectedTotal)}`;
          const costWarning =
            missingCosts > 0
              ? `Cost missing for ${count(missingCosts)} ${missingCosts === 1 ? "reply" : "replies"}.`
              : "";

          if (terminal) {
            const width = Math.max(20, (process.stderr.columns || 80) - 1);
            const height = process.stderr.rows || 24;
            const stacked = width < 75;
            const metrics = `Active ${admission.active}  Limit ${admission.limit}  Retries ${count(retries)}  Invalid ${count(invalid)}`;
            const totals =
              forecastText.length + metrics.length + 2 <= width
                ? [`${forecastText}  ${metrics}`]
                : [forecastText, metrics];
            const failures = models.filter((model) => model.error !== undefined);
            const summary = `${outcome ?? "Sampling"} ${percent.toFixed(1)}%  ${count(saved)}/${count(daily.remaining)} saved`;
            const heading =
              summary.length + costText.length + 2 <= width
                ? [`${summary}  ${costText}`]
                : [summary, costText];
            const slots = Math.max(
              1,
              Math.floor(
                (height -
                  9 -
                  Math.min(1, failures.length) -
                  (heading.length - 1) -
                  (totals.length - 1) -
                  (stacked ? 1 : 0) -
                  (costWarning ? 1 : 0)) /
                  (stacked ? 2 : 1),
              ),
            );
            const page = outcome ? 0 : Math.floor(elapsed / 10) % Math.ceil(models.length / slots);
            const visible = outcome ? models : models.slice(page * slots, (page + 1) * slots);
            const tallyWidth = Math.max(
              9,
              ...models.map(
                (model) => `${count(model.entry.remaining)}/${count(model.entry.remaining)}`.length,
              ),
            );
            const expanded = width >= 110;
            const stateWidth = width < 65 ? 12 : 16;
            const costWidth = Math.max(
              10,
              ...models.map((model) => spent(model.cost, model.missingCosts).length),
            );
            const estimateWidth = Math.max(
              10,
              ...projections.map((value) => estimated(value).length),
            );
            const nameWidth = Math.max(
              8,
              stacked
                ? width
                : width - tallyWidth - costWidth - estimateWidth - stateWidth - (expanded ? 24 : 8),
            );
            const row = (
              name: string,
              tally: string,
              active: string,
              retry: string,
              cost: string,
              forecast: string,
              state: string,
            ) =>
              stacked
                ? [
                    clip(name, width),
                    [
                      tally.padStart(tallyWidth),
                      cost.padStart(costWidth),
                      forecast.padStart(estimateWidth),
                      clip(state, stateWidth),
                    ].join("  "),
                  ].join("\n")
                : [
                    clip(name, nameWidth).padEnd(nameWidth),
                    tally.padStart(tallyWidth),
                    ...(expanded ? [active.padStart(6), retry.padStart(6)] : []),
                    cost.padStart(costWidth),
                    forecast.padStart(estimateWidth),
                    clip(state, stateWidth),
                  ].join("  ");
            const barWidth = Math.min(24, width - (heading[0]?.length ?? 0) - 3);
            const filled = Math.floor(barWidth * Math.min(1, percent / 100));
            const lines = [
              ...heading.map((line, i) =>
                i === 0 && barWidth >= 4
                  ? `${line} [${"#".repeat(filled)}${"-".repeat(barWidth - filled)}]`
                  : line,
              ),
              stats,
              ...totals,
              [wait, last].filter(Boolean).join("  "),
              ...(costWarning ? [costWarning] : []),
              "",
              row("Model", "Saved", "Active", "Retry", "Cost (USD)", "Est. total", "State"),
              ...visible.map((model) => {
                const mode = ` (${model.entry.series.reasoning})`;
                const name =
                  clip(model.entry.series.modelSlug, Math.max(1, nameWidth - mode.length)) + mode;
                return row(
                  name,
                  `${count(model.saved)}/${count(model.entry.remaining)}`,
                  String(model.active),
                  String(model.retries),
                  spent(model.cost, model.missingCosts),
                  estimated(projectedCost(model)),
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
            ]
              .flatMap((line) => line.split("\n"))
              .map((line) => line.slice(0, width));
            if (drawnLines > 0) process.stderr.write(`\x1b[${drawnLines}A\r\x1b[0J`);
            process.stderr.write(`${lines.join("\n")}\n`);
            drawnLines = lines.length;
          } else {
            const details = now - lastDetailsAt >= 60_000 || outcome !== undefined;
            const lines = [
              `${formatSampleProgress({ completed: saved, total: daily.remaining })} (${percent.toFixed(1)}%)  ${costText}  ${forecastText}  ${stats}  Active ${admission.active}  Limit ${admission.limit}  Retries ${retries}  Invalid ${invalid}${wait ? `  ${wait}` : ""}${outcome ? `  ${outcome}` : ""}`,
              ...(costWarning ? [costWarning] : []),
            ];
            for (const model of models) {
              const key = model.entry.series.model;
              const finished = model.finished && !reported.has(key);
              if (details || finished) {
                lines.push(
                  `[${key}] ${model.saved}/${model.entry.remaining} saved  Cost ${spent(model.cost, model.missingCosts)}  Est. total ${estimated(projectedCost(model))}  ${model.active} active  ${model.retries} retries  ${states.get(model)}`,
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
