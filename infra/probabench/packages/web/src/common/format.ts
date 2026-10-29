// How every view writes numbers and times. Times are always UTC.

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

export const percent = (value: number, digits = 1): string =>
  `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: digits })}%`;

export const NO_VALID_REPLIES = "No valid replies";

/** The observed one-rate at a target, which has none without a valid reply. */
export const observedText = (observed: number | null): string =>
  observed === null ? NO_VALID_REPLIES : percent(observed);

export const date = (iso: string): string => DATE.format(new Date(iso));

export const time = (iso: string): string => TIME.format(new Date(iso));

export const timestamp = (iso: string): string => `${date(iso)} · ${time(iso)} UTC`;

export const modelName = (model: string): string => model.split("/").at(-1) ?? model;
