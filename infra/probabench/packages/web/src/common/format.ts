export const number = (value: number): string => value.toLocaleString("en-US");

export const percent = (value: number | null, digits = 1): string =>
  value === null
    ? "—"
    : `${(value * 100).toLocaleString("en-US", { maximumFractionDigits: digits })}%`;

export const date = (value: string): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));

export const time = (value: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(value),
  );

export const modelName = (model: string): string => model.split("/").at(-1) ?? model;
