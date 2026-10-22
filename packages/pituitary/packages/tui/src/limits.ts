import type { Limits, LimitWindow } from "@pituitary/rpc";
import { counted } from "./plural.ts";

/** Use at which a limit warns, then alarms, as the context gauge does. */
export const LIMIT_WARN = 0.7;
export const LIMIT_ALARM = 0.9;

/** Use past which the footer says when the nearest window starts afresh. */
export const RESET_SHOWN = LIMIT_WARN;

export type LimitTone = "calm" | "warn" | "alarm";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const UNITS = new Map([
  ["m", "minute"],
  ["h", "hour"],
  ["d", "day"],
]);

/**
 * A window's name in words: `5h` is the five-hour window and `7d` the weekly one. Other
 * names read the same way, a duration then any qualifier: `7d_opus` is "seven-day opus".
 */
export function windowName(id: string): string {
  if (id === "7d") return "weekly";
  if (id === "7d_oi") return "weekly, extra usage included";
  const match = /^(\d+)([mhd])(?:[_-](.+))?$/.exec(id);
  if (!match) return id.replace(/[_-]+/g, " ");
  const [, count = "", unit = "", rest] = match;
  const amount = NUMBER_WORDS[Number(count)] ?? count;
  const duration = `${amount}-${UNITS.get(unit) ?? unit}`;
  return rest ? `${duration} ${rest.replace(/[_-]+/g, " ")}` : duration;
}

/** A window's short name: `5h`, `wk` for the weekly window, `wk opus` for `7d_opus`. */
export function windowShort(id: string): string {
  const match = /^(\d+)([mhd])(?:[_-](.+))?$/.exec(id);
  if (!match) return id.replace(/[_-]+/g, " ");
  const [, count = "", unit = "", rest] = match;
  const span = count === "7" && unit === "d" ? "wk" : `${count}${unit}`;
  if (rest === "oi") return `${span}+extra`;
  return rest ? `${span} ${rest.replace(/[_-]+/g, " ")}` : span;
}

/** How near a window is, by its use and by what Anthropic says of the window that binds. */
export function windowTone(window: LimitWindow, limits: Limits): LimitTone {
  const used = window.utilization ?? 0;
  const binding = limits.binding === window.id;
  if (used >= LIMIT_ALARM || (binding && limits.status === "rejected")) return "alarm";
  if (used >= LIMIT_WARN || (binding && limits.status === "allowed_warning")) return "warn";
  return "calm";
}

/** The worst of `tones`. */
export function worst(tones: readonly LimitTone[]): LimitTone {
  if (tones.includes("alarm")) return "alarm";
  if (tones.includes("warn")) return "warn";
  return "calm";
}

/** Windows still current at `now`; one whose reset has passed starts afresh unmeasured. */
export function currentWindows(limits: Limits, now = Date.now()): LimitWindow[] {
  return limits.windows.filter(
    (window) => window.utilization !== null && (window.resetsAt === null || window.resetsAt > now),
  );
}

/** Whole percent of a fraction. */
export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** How long until `at`, in words: "in 45 minutes", "in 3 hours", "in 2 days". */
export function until(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const unit = (count: number, name: string) => `in ${counted(count, name)}`;
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

/** How long until `at`, in its largest whole unit: "42m", "3h", "2d". */
export function untilShort(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Extra usage worth showing: in use now, or spent from this month's cap. */
export function extraShown(limits: Limits): boolean {
  const extra = limits.extra;
  return Boolean(extra && (extra.active || (extra.monthly ?? 0) > 0));
}

/** How much extra usage has taken, as a fraction: of the monthly cap when known, of its allowance otherwise. */
export function extraUsed(limits: Limits): number | null {
  return limits.extra?.monthly ?? limits.extra?.utilization ?? null;
}

export function extraTone(limits: Limits): LimitTone {
  const extra = limits.extra;
  if (!extra) return "calm";
  const used = extraUsed(limits) ?? 0;
  if (extra.status === "rejected" || used >= LIMIT_ALARM) return "alarm";
  if (extra.active || extra.status === "allowed_warning" || used >= LIMIT_WARN) return "warn";
  return "calm";
}

/** Every window and the extra-usage state, a line each, as `/usage` shows them. */
export function usageReport(limits: Limits | null, now = Date.now()): string {
  if (!limits) {
    return "No usage limits reported yet. They arrive with each reply from a Claude subscription, so send a prompt first.";
  }
  const nameWidth = Math.max(0, ...limits.windows.map((window) => windowName(window.id).length));
  return [
    `Usage limits, as of the reply ${agoWords(limits.receivedAt, now)}:`,
    ...limits.windows.map((window) => windowLine(window, limits, nameWidth, now)),
    ...(STATUS_LINES.get(limits.status ?? "") ?? []),
    ...(limits.extra ? extraLines(limits.extra, now) : []),
    "Spend in dollars is on the usage page of claude.ai's settings.",
  ].join("\n");
}

/** What the subscription's state adds to the report, by its status. */
const STATUS_LINES = new Map([
  ["allowed_warning", ["Anthropic warns that a limit is near."]],
  ["rejected", ["A limit is reached."]],
]);

/** One window's line of the report: how much of it is used, when it resets, and whether it is the one that applies. */
function windowLine(window: LimitWindow, limits: Limits, nameWidth: number, now: number): string {
  const name = windowName(window.id).padEnd(nameWidth);
  const used = window.utilization === null ? "use not reported" : `${percent(window.utilization)} used`;
  const binding = limits.binding === window.id ? " · the limit that applies now" : "";
  return `  ${name}  ${used}${resetOf(window.resetsAt, now)}${binding}`;
}

/** When a window resets, or that it already has. */
function resetOf(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "";
  return resetsAt <= now ? " · has started afresh since" : ` · resets ${until(resetsAt, now)}`;
}

/** How much of extra usage is spent: of the month's cap where one is set, of the allowance otherwise. */
function spentLines(extra: NonNullable<Limits["extra"]>): string[] {
  if (extra.monthly !== null) return [`  ${percent(extra.monthly)} of this month's spending cap is spent.`];
  if (extra.utilization !== null)
    return [`  ${percent(extra.utilization)} of the extra-usage allowance is used.`];
  return [];
}

/** Extra usage's lines of the report: whether it is in use, how much of it is spent, and why it stops. */
function extraLines(extra: NonNullable<Limits["extra"]>, now: number): string[] {
  return [
    extra.active
      ? "Extra usage is in use: replies are billed past the subscription."
      : "Extra usage is not in use.",
    ...spentLines(extra),
    ...(extra.status === "rejected" ? ["  Extra usage is at its cap or turned off."] : []),
    ...(extra.disabledReason
      ? [`  Anthropic gives the reason: ${extra.disabledReason.replace(/_/g, " ")}.`]
      : []),
    ...(extra.resetsAt !== null && extra.resetsAt > now
      ? [`  It starts afresh ${until(extra.resetsAt, now)}.`]
      : []),
  ];
}

function agoWords(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${counted(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  return `${counted(hours, "hour")} ago`;
}
