import { fileURLToPath } from "node:url";

const own = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Pituitary's own Pi extensions, which its regular Pi conversations load after the operator's. */
export const PI_EXTENSIONS = {
  fast: own("./pi-fast.ts"),
  usage: own("./pi-usage.ts"),
  bridge: own("./pi-bridge-extension.ts"),
} as const;

/** Loaded only for a handoff to Pi's own screens. */
export const HANDOFF_EXTENSION = own("./pi-handoff.ts");

/** The arguments that load Pituitary's own extensions into Pi. */
export const extensionArgs = (): string[] =>
  Object.values(PI_EXTENSIONS).flatMap((path) => ["--extension", path]);
