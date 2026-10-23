// How every view writes numbers, times and run settings. Times are always UTC.
import type { Run } from "@probabench/domain";

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const TIME = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export const count = (value: number): string => value.toLocaleString("en-US");

export const percent = (value: number | null, digits = 1): string =>
  value === null
    ? "—"
    : `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: digits })}%`;

/** A calibration error, given as a fraction, in percentage points. */
export const calibrationErrorText = (value: number | null, empty = "—"): string =>
  value === null ? empty : `${(value * 100).toFixed(1)} pp`;

export const date = (iso: string): string => DATE.format(new Date(iso));

export const time = (iso: string): string => TIME.format(new Date(iso));

export const timestamp = (iso: string): string => `${date(iso)} · ${time(iso)} UTC`;

/** Enough of a run id to tell a model's runs apart. */
export const shortId = (id: string): string => id.slice(-6);

export const samplingText = (run: Pick<Run, "trialsPerStep" | "stepPercent">): string =>
  `${count(run.trialsPerStep)} samples / target · ${run.stepPercent}% step`;

export const modelName = (model: string): string => model.split("/").at(-1) ?? model;
