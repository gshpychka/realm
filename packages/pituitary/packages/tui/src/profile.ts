import { appendFileSync } from "node:fs";

/** Where timing marks go, when PITUITARY_PROFILE names a file. */
const file = process.env.PITUITARY_PROFILE;
const seen = new Set<string>();

/**
 * Records when `name` happened, once per name, as a `name offset epoch` line: milliseconds
 * since the process started, and the wall clock in milliseconds for comparing with another
 * process. Written synchronously so a mark taken on the way out lands before the process exits.
 */
export function mark(name: string): void {
  if (!file || seen.has(name)) return;
  seen.add(name);
  const now = performance.now();
  appendFileSync(file, `${name} ${now.toFixed(1)} ${(performance.timeOrigin + now).toFixed(1)}\n`);
}
