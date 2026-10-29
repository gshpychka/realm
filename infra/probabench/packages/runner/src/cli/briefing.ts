// One model table combines the daily work and its price before confirmation.
import { type CostEstimate, formatCost, planBudget } from "@probabench/domain";
import type { DailyPlan } from "../plan/daily";
import type { BenchPlan } from "../plan/plan";

const count = (value: number): string => value.toLocaleString("en-US");
const wrap = (text: string, width: number): string => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
};

export const describeBriefing = (
  plan: BenchPlan,
  daily: DailyPlan,
  estimate: CostEstimate,
  width = 80,
): string => {
  const prices = new Map(estimate.models.map((model) => [model.model, model.cost]));
  const rows = daily.series.map(({ series, remaining }) => [
    series.modelSlug,
    series.reasoning,
    count(remaining),
    remaining === 0
      ? "Already saved"
      : formatCost(prices.get(series.model) ?? null).replaceAll("$", ""),
  ]);
  const headings = ["Model", "Reasoning", "Requests", "Cost (USD)"];
  const totals = [
    "Total",
    "",
    count(daily.remaining),
    formatCost(estimate.cost).replaceAll("$", ""),
  ];
  const columns = headings.map((heading, i) =>
    Math.max(heading.length, totals[i]?.length ?? 0, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const tableWidth = columns.reduce((sum, column) => sum + column, 0) + 6;
  const row = (cells: readonly string[], offset = 0): string =>
    cells
      .map((cell, i) => {
        const column = i + offset;
        return column < 2 ? cell.padEnd(columns[column] ?? 0) : cell.padStart(columns[column] ?? 0);
      })
      .join("  ")
      .trimEnd();
  const table =
    tableWidth <= width
      ? [
          row(headings),
          "─".repeat(tableWidth),
          ...rows.map((cells) => row(cells)),
          "─".repeat(tableWidth),
          row(totals),
        ]
      : [
          `  ${row(headings.slice(1), 1)}`,
          ...rows.flatMap((cells) => [cells[0] ?? "", `  ${row(cells.slice(1), 1)}`]),
          "",
          wrap(
            `${count(daily.remaining)} requests · Estimated cost ${formatCost(estimate.cost)}`,
            width,
          ),
        ];
  const pending = daily.series.filter((entry) => entry.remaining > 0);
  const limits = [
    ...(pending.some(({ series }) => series.reasoning === "off") ? ["16 when reasoning off"] : []),
    ...(pending.some(({ series }) => series.reasoning !== "off")
      ? [`${count(plan.options.maxTokens)} when reasoning on`]
      : []),
  ];
  const { points } = planBudget(plan.options);
  const notes =
    estimate.requests === 0
      ? []
      : [
          "Cost range uses estimated input and 1 output token through the output limit.",
          `Output limits (tokens, including reasoning): ${limits.join("; ")}.`,
          "Prices may vary; fees and taxes excluded.",
        ];
  return [
    wrap(
      `Daily target: ${count(plan.options.trialsPerStep)} samples × ${points} probabilities per model (${plan.options.stepPercent}% steps)`,
      width,
    ),
    wrap(`${daily.day} UTC · Concurrency limit ${count(plan.options.concurrency)}`, width),
    "",
    ...table,
    "",
    ...(estimate.warning ? [wrap(estimate.warning, width)] : []),
    ...notes.map((note) => wrap(note, width)),
  ]
    .join("\n")
    .trimEnd();
};
