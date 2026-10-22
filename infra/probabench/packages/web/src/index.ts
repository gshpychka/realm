// @probabench/web — Vite + React + Tailwind presentation. Reads results.json and
// charts observed sampling frequencies. The shared domain schema validates the
// published results before they reach the chart.
import { Results } from "@probabench/domain";

export const WEB_PACKAGE = "@probabench/web" as const;
export const RESULTS_SCHEMA = Results;
