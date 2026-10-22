/**
 * Usage limits of a Claude subscription, as Anthropic reports them on every response.
 *
 * Each limit window arrives as `anthropic-ratelimit-unified-<window>-utilization` (a
 * fraction of the window used) and `-reset` (epoch seconds), beside an overall `-status`
 * and the window that binds (`-representative-claim`). Extra usage, billed past the
 * subscription, reports under `overage`.
 */

/** Header names the bridge forwards and pituitary accepts; nothing else about a response leaves pi. */
export const LIMIT_HEADER_PREFIX = "anthropic-ratelimit-unified-";

/** Most headers kept from one response, and the longest value, so a response cannot flood the bridge. */
const MOST_HEADERS = 64;
const LONGEST_VALUE = 256;

/** How close a window is, as Anthropic judges it. */
export type LimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface LimitWindow {
  /** The window's own name in the headers, such as `5h` or `7d`. */
  id: string;
  /** Fraction of the window used, 0 to 1. */
  utilization: number | null;
  /** When the window starts afresh, in epoch milliseconds. */
  resetsAt: number | null;
}

export interface ExtraUsage {
  status: LimitStatus | null;
  /** True while replies are billed as extra usage. */
  active: boolean;
  /** Fraction of the extra-usage allowance used, 0 to 1. */
  utilization: number | null;
  /** Fraction of the monthly spending cap used, 0 to 1. */
  monthly: number | null;
  resetsAt: number | null;
  /** Why extra usage is off, when Anthropic says. */
  disabledReason: string | null;
}

export interface Limits {
  status: LimitStatus | null;
  /** The window whose limit applies now. */
  binding: string | null;
  /** The subscription's limit windows, in the order Anthropic sent them. */
  windows: LimitWindow[];
  extra: ExtraUsage | null;
  /** When pi received the response these came from, in epoch milliseconds. */
  receivedAt: number;
}

/** The headers of a response that carry usage limits, lowercased and bounded. */
export function limitHeaders(headers: Readonly<Record<string, unknown>>): Record<string, string> {
  const kept: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!key.startsWith(LIMIT_HEADER_PREFIX) || typeof value !== "string") continue;
    if (value.length > LONGEST_VALUE || count >= MOST_HEADERS) continue;
    kept[key] = value;
    count++;
  }
  return kept;
}

const STATUSES: readonly string[] = ["allowed", "allowed_warning", "rejected"];

/** Claims name windows in words; the headers name them by duration. */
const CLAIMS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d_oi",
  overage: "overage",
};

/** Windows reported under these names are not usage limits: low-priority budgets and grace allowances. */
const NOT_WINDOWS = /^(slow|grace)-/;

const WINDOW_FIELD = /^(.+)-(utilization|reset)$/;

function status(value: string | undefined): LimitStatus | null {
  return value && STATUSES.includes(value) ? (value as LimitStatus) : null;
}

function fraction(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

function instant(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) * 1000 : null;
}

/** Usage limits from one response's headers; null when the response carried none. */
export function readLimits(
  headers: Readonly<Record<string, string>>,
  receivedAt = Date.now(),
): Limits | null {
  const kept = limitHeaders(headers);
  const field = (name: string) => kept[`${LIMIT_HEADER_PREFIX}${name}`];
  const windows = new Map<string, LimitWindow>();
  for (const name of Object.keys(kept)) {
    const match = WINDOW_FIELD.exec(name.slice(LIMIT_HEADER_PREFIX.length));
    const id = match?.[1];
    if (!id || id === "overage" || id.startsWith("overage-") || NOT_WINDOWS.test(id)) continue;
    if (!windows.has(id)) {
      windows.set(id, {
        id,
        utilization: fraction(field(`${id}-utilization`)),
        resetsAt: instant(field(`${id}-reset`)),
      });
    }
  }
  const measured = [...windows.values()].filter(
    (window) => window.utilization !== null || window.resetsAt !== null,
  );

  const overall = status(field("status"));
  const extraStatus = status(field("overage-status"));
  const extraFields = [
    "overage-status",
    "overage-in-use",
    "overage-utilization",
    "overage-period-monthly-utilization",
  ];
  const extra: ExtraUsage | null = extraFields.some((name) => field(name) !== undefined)
    ? {
        status: extraStatus,
        // Past the subscription's own limit, replies continue as extra usage while it is allowed.
        active:
          field("overage-in-use") === "true" ||
          (overall === "rejected" && (extraStatus === "allowed" || extraStatus === "allowed_warning")),
        utilization: fraction(field("overage-utilization")),
        monthly: fraction(field("overage-period-monthly-utilization")),
        resetsAt: instant(field("overage-reset")),
        disabledReason: field("overage-disabled-reason") ?? null,
      }
    : null;

  if (measured.length === 0 && overall === null && extra === null) return null;
  const claim = field("representative-claim");
  return {
    status: overall,
    binding: claim ? (CLAIMS[claim] ?? claim) : null,
    windows: measured,
    extra,
    receivedAt,
  };
}
