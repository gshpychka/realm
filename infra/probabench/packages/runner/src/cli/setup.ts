import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type * as FileSystem from "@effect/platform/FileSystem";
import type * as HttpClient from "@effect/platform/HttpClient";
import { formatCost, ReasoningMode, type Results, seriesLabel } from "@probabench/domain";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import { costForDaily } from "../plan/cost";
import { planDaily } from "../plan/daily";
import { type BenchPlan, InvalidOptions } from "../plan/plan";
import { loadPrices, type Prices } from "../plan/pricing";
import type { ModelSeries } from "../plan/series";
import {
  type Configuration,
  defaultConfiguration,
  initialConfiguration,
  loadConfiguration,
  type SetupOverrides,
  saveConfiguration,
} from "./configuration";

interface ModelRow {
  readonly slug: string;
  selected: boolean;
  reasoning: ReasoningMode;
  trials: number;
  step: number;
}

type Field = "reasoning" | "trials" | "step" | "concurrency" | "maxTokens";
interface Editor {
  readonly field: Field;
  readonly targets: readonly number[];
  value: string;
  replace: boolean;
}

const colors = {
  base: "\x1b[0m\x1b[48;2;40;40;40m\x1b[38;2;235;219;178m",
  muted: "\x1b[38;2;146;131;116m",
  accent: "\x1b[38;2;250;189;47m",
  green: "\x1b[38;2;184;187;38m",
  focus: "\x1b[48;2;60;56;54m\x1b[38;2;250;189;47m",
  error: "\x1b[38;2;251;73;52m",
};
const count = (value: number) => value.toLocaleString("en-US");
const centered = (value: string, width: number) =>
  value.padStart(value.length + Math.floor((width - value.length) / 2)).padEnd(width);
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const clip = (value: string, width: number): string => {
  const clean = stripVTControlCharacters(value);
  return clean.length <= width ? clean : `${clean.slice(0, Math.max(0, width - 1))}…`;
};
const fitLine = (line: string, width: number): string => {
  let remaining = width;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve terminal styling while clipping visible text.
  const sequences = /(\x1b\[[0-9;?]*[A-Za-z])/;
  return line
    .split(sequences)
    .map((part) => {
      if (part.startsWith("\x1b[")) return part;
      const text = part.slice(0, remaining);
      remaining -= text.length;
      return text;
    })
    .join("");
};
const editValue = (editor: Editor): number | ReasoningMode | null => {
  if (editor.field === "reasoning") {
    const matches = ReasoningMode.literals.filter((mode) =>
      mode.startsWith(editor.value.toLowerCase()),
    );
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
  const number = Number(editor.value);
  return /^\d+$/.test(editor.value) &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    (editor.field !== "step" || number <= 100)
    ? number
    : null;
};

/** Keyboard setup owns stdin until settings are saved or discarded. */
export const configure = (
  initial: BenchPlan,
  history: Results,
  initialPrices: Prices,
  settings: { readonly overrides?: SetupOverrides; readonly path?: string } = {},
) =>
  Effect.gen(function* () {
    const loaded = yield* loadConfiguration(settings.path);
    const config = initialConfiguration(loaded.config, settings.overrides);
    const runtime = yield* Effect.runtime<FileSystem.FileSystem | HttpClient.HttpClient>();
    const configured = yield* Effect.async<
      { plan: BenchPlan; config: Configuration } | null,
      InvalidOptions
    >((resume) => {
      const input = process.stdin;
      const output = process.stdout;
      const wasRaw = input.isRaw;
      let rows: ModelRow[] = config.models.map((model) => ({ ...model }));
      let concurrency = config.concurrency;
      let maxTokens = config.maxTokens;
      let prices = initialPrices;
      // Settings, the bulk row, individual models, then the action buttons.
      let row = 0;
      let column = 0;
      let editor: Editor | undefined;
      let refreshing = false;
      let message = loaded.warning ?? "";
      let closed = false;
      const refreshController = new AbortController();

      const selected = () => rows.flatMap((entry, index) => (entry.selected ? [index] : []));
      const targets = () => (row === 0 ? selected() : [row - 1]);
      const fieldAt = (): Field | null =>
        row === -1
          ? column === 0
            ? "concurrency"
            : "maxTokens"
          : row <= rows.length
            ? (([null, "reasoning", "step", "trials"] as const)[column] ?? null)
            : null;
      const columnCount = () => (row === -1 ? 2 : row > rows.length ? 3 : 4);
      const apply = (edit: Editor, models: ModelRow[]) => {
        const value = editValue(edit);
        for (const index of edit.targets) {
          const model = models[index];
          if (!model) continue;
          if (edit.field === "reasoning" && typeof value === "string") model.reasoning = value;
          if (edit.field === "step" && typeof value === "number") model.step = value;
          if (edit.field === "trials" && typeof value === "number") model.trials = value;
        }
      };
      const snapshot = (): Configuration => {
        const models = rows.map((entry) => ({ ...entry }));
        if (editor) apply(editor, models);
        const value = editor ? editValue(editor) : null;
        return {
          models,
          concurrency:
            editor?.field === "concurrency" && typeof value === "number" ? value : concurrency,
          maxTokens: editor?.field === "maxTokens" && typeof value === "number" ? value : maxTokens,
        };
      };
      const makePlan = (draft = snapshot()): BenchPlan | null => {
        const series = draft.models
          .filter((entry) => entry.selected)
          .map(
            (entry): ModelSeries => ({
              model: seriesLabel(entry.slug, entry.reasoning),
              modelSlug: entry.slug,
              reasoning: entry.reasoning,
            }),
          );
        const [first, ...rest] = series;
        if (!first) return null;
        return {
          ...initial,
          series: [first, ...rest],
          options: {
            ...initial.options,
            concurrency: draft.concurrency,
            maxTokens: draft.maxTokens,
          },
          modelOptions: new Map(
            draft.models.map((entry) => [
              seriesLabel(entry.slug, entry.reasoning),
              { trialsPerStep: entry.trials, stepPercent: entry.step },
            ]),
          ),
        };
      };
      const beginEdit = () => {
        const field = fieldAt();
        if (!field) return;
        const indexes = field === "concurrency" || field === "maxTokens" ? [] : targets();
        if (row === 0 && indexes.length === 0) {
          message = "Select a model first.";
          return;
        }
        const model = rows[indexes[0] ?? -1];
        const value =
          field === "concurrency"
            ? concurrency
            : field === "maxTokens"
              ? maxTokens
              : model?.[field];
        if (value === undefined) return;
        editor = { field, targets: indexes, value: String(value), replace: true };
      };
      const commit = (): boolean => {
        if (!editor) return true;
        const value = editValue(editor);
        if (value === null) return false;
        apply(editor, rows);
        if (editor.field === "concurrency" && typeof value === "number") concurrency = value;
        if (editor.field === "maxTokens" && typeof value === "number") maxTokens = value;
        editor = undefined;
        return true;
      };
      const nextField = (backward: boolean) => {
        column += backward ? -1 : 1;
        if (column < 0) {
          row = row === -1 ? rows.length + 1 : row - 1;
          column = columnCount() - 1;
        } else if (column >= columnCount()) {
          row = row === rows.length + 1 ? -1 : row + 1;
          column = 0;
        }
      };
      const adjust = (direction: number, large: boolean) => {
        if (!editor) return;
        const value = editValue(editor);
        if (editor.field === "reasoning") {
          const current = typeof value === "string" ? ReasoningMode.literals.indexOf(value) : 0;
          editor.value =
            ReasoningMode.literals[
              Math.max(0, Math.min(ReasoningMode.literals.length - 1, current + direction))
            ] ?? "off";
        } else {
          const current = typeof value === "number" ? value : 1;
          const maximum = editor.field === "step" ? 100 : Number.MAX_SAFE_INTEGER;
          editor.value = String(
            Math.max(1, Math.min(maximum, current + direction * (large ? 10 : 1))),
          );
        }
        editor.replace = true;
      };
      const render = () => {
        if (closed) return;
        const width = Math.max(1, (output.columns || 80) - 1);
        const height = output.rows || 24;
        if (width < 68 || height < 18) {
          output.write(
            `${colors.base}\x1b[H\x1b[2JProbaBench\r\nResize terminal to at least 69 × 18.\r\nEsc to quit`,
          );
          return;
        }
        const now = new Date().toISOString();
        const draft = snapshot();
        const allPlan = makePlan({
          ...draft,
          models: draft.models.map((model) => ({ ...model, selected: true })),
        });
        const allDaily = allPlan ? planDaily(allPlan, history, now) : null;
        const chosen = draft.models.filter((model) => model.selected);
        const keys = new Set(chosen.map((model) => seriesLabel(model.slug, model.reasoning)));
        const series = allDaily?.series.filter((entry) => keys.has(entry.series.model)) ?? [];
        const remaining = series.reduce((sum, entry) => sum + entry.remaining, 0);
        const target = series.reduce(
          (sum, entry) => sum + entry.options.trialsPerStep * entry.points.length,
          0,
        );
        const estimate = allDaily ? costForDaily({ ...allDaily, series, remaining }, prices) : null;
        const costs = new Map(estimate?.models.map((entry) => [entry.model, entry.cost]) ?? []);
        const dailyByModel = new Map(
          allDaily?.series.map((entry) => [entry.series.model, entry]) ?? [],
        );
        const wide = width >= 108;
        const costWidth = Math.max(
          14,
          ...[...costs.values()].map((cost) => formatCost(cost).length),
        );
        const columns = wide ? [3, 0, 9, 6, 7, 14, 10, costWidth] : [3, 0, 9, 6, 7, costWidth];
        columns[1] = Math.max(
          12,
          width - columns.reduce((sum, size) => sum + size, 0) - columns.length + 1,
        );
        const activeColumn = column === 0 ? 0 : column + 1;
        const cell = (value: string, index: number, focus: boolean, dim = false) => {
          const size = columns[index] ?? 1;
          const text = clip(value, size);
          const padded =
            index >= 2 && index <= 4
              ? centered(text, size)
              : index < 2
                ? text.padEnd(size)
                : text.padStart(size);
          return `${focus ? colors.focus : dim ? colors.muted : ""}${padded}${colors.base}`;
        };
        const table = (cells: string[], index: number, dim = false) =>
          cells
            .map((value, i) => cell(value, i, index === row && i === activeColumn, dim))
            .join(" ");
        const indicators = (above: boolean, settingsRow = false): string => {
          if (!editor) return "";
          const glyph = above ? "▴" : "▾";
          const value = editValue(editor);
          const disabled =
            typeof value === "number"
              ? above
                ? value === (editor.field === "step" ? 100 : Number.MAX_SAFE_INTEGER)
                : value === 1
              : above
                ? value === "xhigh"
                : value === "off";
          const color = disabled ? colors.muted : colors.accent;
          if (settingsRow) {
            const start = column === 0 ? 12 : 36;
            return `${" ".repeat(start + (column === 0 ? 2 : 3))}${color}${glyph}${colors.base}`;
          }
          const start = columns.slice(0, activeColumn).reduce((sum, size) => sum + size + 1, 0);
          const middle = start + Math.floor(((columns[activeColumn] ?? 1) - 1) / 2);
          return `${" ".repeat(middle)}${color}${glyph}${colors.base}`;
        };
        const common = (field: "reasoning" | "step" | "trials") => {
          if (editor && row === 0 && editor.field === field)
            return field === "reasoning"
              ? title(editor.value || "_")
              : `${editor.value || "_"}${field === "step" ? "%" : ""}`;
          const values = new Set(chosen.map((entry) => entry[field]));
          const value = chosen[0]?.[field];
          return values.size === 1 && value !== undefined
            ? field === "reasoning"
              ? title(String(value))
              : `${count(Number(value))}${field === "step" ? "%" : ""}`
            : "—";
        };
        const warning =
          message ||
          (editor && editValue(editor) === null
            ? editor.field === "reasoning"
              ? "Off, Minimal, Low, Medium, High or Xhigh."
              : editor.field === "step"
                ? "Choose a whole number from 1 to 100."
                : "Choose a positive whole number."
            : estimate?.warning || prices.warning || "");
        const slots = Math.max(1, height - 15 - (editor ? 2 : 0) - (warning ? 1 : 0));
        const offset = Math.max(0, Math.min(rows.length - slots, row - slots));
        const visible = draft.models.slice(offset, offset + slots);
        const setting = (value: string, size: number, index: number) =>
          `${row === -1 && column === index ? colors.focus : colors.accent}${centered(clip(value, size), size)}${colors.base}`;
        const concurrencyText =
          editor?.field === "concurrency" ? editor.value || "_" : count(draft.concurrency);
        const tokenText =
          editor?.field === "maxTokens" ? editor.value || "_" : count(draft.maxTokens);
        const lines = [
          `${colors.accent}ProbaBench${colors.base}${colors.muted}    Today · ${now.slice(0, 10)} UTC${colors.base}`,
          ...(editor && row === -1 ? [indicators(true, true)] : []),
          `${colors.muted}Concurrency${colors.base} ${setting(concurrencyText, 6, 0)}     ${colors.muted}Output limit${colors.base} ${setting(tokenText, 8, 1)} tokens`,
          ...(editor && row === -1 ? [indicators(false, true)] : []),
          "",
          `${colors.muted}${table(
            wide
              ? [
                  "",
                  "Model",
                  "Reasoning",
                  "Step",
                  "Trials",
                  "Saved / target",
                  "To collect",
                  "Estimated cost",
                ]
              : ["", "Model", "Reasoning", "Step", "Trials", "Estimated cost"],
            -2,
            true,
          )}${colors.base}`,
          ...(editor && row === 0 ? [indicators(true)] : []),
          table(
            wide
              ? [
                  chosen.length === rows.length ? "[✓]" : chosen.length ? "[−]" : "[ ]",
                  "Selected models",
                  common("reasoning"),
                  common("step"),
                  common("trials"),
                  "",
                  "",
                  "",
                ]
              : [
                  chosen.length === rows.length ? "[✓]" : chosen.length ? "[−]" : "[ ]",
                  "Selected models",
                  common("reasoning"),
                  common("step"),
                  common("trials"),
                  "",
                ],
            0,
          ),
          ...(editor && row === 0 ? [indicators(false)] : []),
        ];
        for (const [index, entry] of visible.entries()) {
          const absolute = offset + index + 1;
          const key = seriesLabel(entry.slug, entry.reasoning);
          const daily = dailyByModel.get(key);
          const goal = (daily?.points.length ?? 0) * entry.trials;
          const toCollect = daily?.remaining ?? 0;
          const reasoning =
            editor?.field === "reasoning" && row === absolute
              ? title(editor.value || "_")
              : title(entry.reasoning);
          const step =
            editor?.field === "step" && row === absolute
              ? `${editor.value || "_"}%`
              : `${entry.step}%`;
          const trials =
            editor?.field === "trials" && row === absolute
              ? editor.value || "_"
              : count(entry.trials);
          const cost = entry.selected
            ? formatCost(toCollect === 0 ? { low: 0, high: 0 } : (costs.get(key) ?? null))
            : "—";
          const cells = [entry.selected ? "[✓]" : "[ ]", entry.slug, reasoning, step, trials];
          if (wide)
            cells.push(
              `${count(goal - toCollect)} / ${count(goal)}`,
              entry.selected ? count(toCollect) : "—",
            );
          cells.push(cost);
          if (editor && row === absolute) lines.push(indicators(true));
          lines.push(table(cells, absolute, !entry.selected));
          if (editor && row === absolute) lines.push(indicators(false));
        }
        // Keep the summary and actions anchored while the model list scrolls.
        for (let i = visible.length; i < slots; i++) lines.push("");
        let context: [string, string];
        const active = draft.models[row - 1];
        if (active) {
          const daily = dailyByModel.get(seriesLabel(active.slug, active.reasoning));
          const goal = (daily?.points.length ?? 0) * active.trials;
          context = [
            active.slug,
            `${count(active.trials)} samples per probability · ${count(goal - (daily?.remaining ?? 0))} of ${count(goal)} saved today`,
          ];
        } else if (row === -1) {
          context =
            column === 0
              ? ["Concurrency", "Maximum simultaneous requests across selected models."]
              : ["Output limit", "Limits each reply’s length, including reasoning."];
        } else if (row === rows.length + 1 && column === 1) {
          context = [
            "OpenRouter prices",
            refreshing
              ? "Refreshing…"
              : prices.fetchedAt
                ? `Saved ${prices.fetchedAt.replace("T", " ").slice(0, 16)} UTC`
                : "Unavailable",
          ];
        } else if (row === rows.length + 1 && column === 0) {
          context = ["Restore defaults", "All models · 50 samples per probability · 10% steps"];
        } else if (row === rows.length + 1) {
          context = [
            remaining === 0 && chosen.length
              ? "Today's target is already covered."
              : "Start benchmark",
            "",
          ];
        } else {
          context = [
            "Edit selected models together",
            `${chosen.length} selected${visible.length < rows.length ? ` · Showing ${offset + 1}–${offset + visible.length} of ${rows.length}` : ""}`,
          ];
        }
        const button = (label: string, index: number) => {
          const color =
            row === rows.length + 1 && column === index
              ? colors.focus
              : index === 2 && chosen.length
                ? colors.green
                : colors.muted;
          return `${color} ${label.replace("[s]", `[${colors.accent}\x1b[1ms\x1b[22m${color}]`)} ${colors.base}`;
        };
        lines.push(
          "",
          `${colors.accent}${clip(context[0], width)}${colors.base}`,
          `${colors.muted}${clip(context[1], width)}${colors.base}`,
          "",
          chosen.length
            ? `${count(target - remaining)} of ${count(target)} samples already saved toward today's target`
            : "Select at least one model to start.",
          chosen.length
            ? remaining > 0
              ? `${colors.green}Collect ${count(remaining)} samples${colors.base}    Estimated cost ${formatCost(estimate?.cost ?? null)}`
              : "No samples left to collect today."
            : "",
          "",
          `${button("Reset defaults", 0)}   ${button(refreshing ? "Refreshing…" : "Refresh prices", 1)}   ${button(remaining === 0 && chosen.length ? "Save settings [s]" : "Start benchmark [s]", 2)}`,
          `${colors.muted}${editor ? "↑↓ Adjust · Type a value · Enter Apply · Esc Cancel" : row > rows.length ? "←→ Choose · Enter Activate · s Start · Esc Quit" : `↑↓ Move · ←→ Setting · Enter ${row >= 0 && column === 0 ? "Select" : "Edit"} · s Start · Esc Quit`}${colors.base}`,
          ...(warning ? [`${colors.error}${clip(warning, width)}${colors.base}`] : []),
        );
        output.write(
          `${colors.base}\x1b[H${lines.map((line) => `${fitLine(line, width)}\x1b[K`).join("\r\n")}\x1b[J`,
        );
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        refreshController.abort();
        clearInterval(timer);
        input.off("keypress", onKey);
        input.off("end", cancel);
        output.off("resize", render);
        input.setRawMode(wasRaw);
        input.pause();
        output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
      };
      const finish = (plan: BenchPlan | null) => {
        cleanup();
        resume(Effect.succeed(plan ? { plan, config: snapshot() } : null));
      };
      const cancel = () => finish(null);
      const activate = () => {
        if (row > rows.length) {
          if (column === 0) {
            const defaults = defaultConfiguration();
            rows = defaults.models.map((model) => ({ ...model }));
            concurrency = defaults.concurrency;
            maxTokens = defaults.maxTokens;
            row = 0;
            column = 0;
            message = "Defaults restored.";
          } else if (column === 1 && !refreshing) {
            refreshing = true;
            Runtime.runPromise(runtime)(loadPrices({ refresh: true }), {
              signal: refreshController.signal,
            }).then(
              (next) => {
                prices = next;
                refreshing = false;
                render();
              },
              () => {
                refreshing = false;
                message = "Price refresh failed.";
                render();
              },
            );
          } else if (column === 2) {
            const plan = makePlan();
            if (plan) finish(plan);
            else message = "Select a model first.";
          }
        } else if (row >= 0 && column === 0) {
          if (row === 0) {
            const value = selected().length !== rows.length;
            for (const model of rows) model.selected = value;
          } else {
            const model = rows[row - 1];
            if (model) model.selected = !model.selected;
          }
        } else beginEdit();
      };
      const onKey = (text: string | undefined, key: Key) => {
        message = "";
        if (key.ctrl && (key.name === "c" || key.name === "d")) return cancel();
        if (editor) {
          if (key.name === "escape") editor = undefined;
          else if (key.name === "return") commit();
          else if (key.name === "tab") {
            if (commit()) nextField(key.shift ?? false);
          } else if (key.name === "up" || key.name === "down")
            adjust(key.name === "up" ? 1 : -1, key.shift ?? false);
          else if (key.name === "backspace") {
            editor.value = editor.replace ? "" : editor.value.slice(0, -1);
            editor.replace = false;
          } else if (text && (editor.field === "reasoning" ? /^[a-z]+$/i : /^\d+$/).test(text)) {
            editor.value = (editor.replace ? "" : editor.value) + text.toLowerCase();
            editor.replace = false;
          }
        } else if (key.name === "escape" || key.name === "q") return cancel();
        else if (key.name === "up" || key.name === "down") {
          row = Math.max(-1, Math.min(rows.length + 1, row + (key.name === "up" ? -1 : 1)));
          column = Math.min(column, columnCount() - 1);
        } else if (key.name === "left" || key.name === "right")
          column = Math.max(
            0,
            Math.min(columnCount() - 1, column + (key.name === "left" ? -1 : 1)),
          );
        else if (key.name === "tab") nextField(key.shift ?? false);
        else if (
          key.name === "return" ||
          (key.name === "space" && row >= 0 && row <= rows.length && column === 0)
        )
          activate();
        else if (key.name === "a" || key.name === "n") {
          for (const model of rows) model.selected = key.name === "a";
        } else if (key.name === "c" || key.name === "o") {
          row = -1;
          column = key.name === "c" ? 0 : 1;
        } else if (key.name === "d" || key.name === "r" || key.name === "s") {
          row = rows.length + 1;
          column = key.name === "d" ? 0 : key.name === "r" ? 1 : 2;
          if (key.name !== "s") activate();
        }
        render();
      };
      const timer = setInterval(render, 30_000);
      try {
        emitKeypressEvents(input);
        input.setRawMode(true);
        input.resume();
        input.on("keypress", onKey);
        input.on("end", cancel);
        output.on("resize", render);
        output.write("\x1b[?1049h\x1b[?25l");
        render();
      } catch (cause) {
        cleanup();
        resume(
          Effect.fail(
            new InvalidOptions({
              message: cause instanceof Error ? cause.message : "Could not open terminal setup.",
            }),
          ),
        );
      }
      return Effect.sync(cleanup);
    });
    if (!configured) return null;
    yield* saveConfiguration(configured.config, settings.path);
    return configured.plan;
  });
