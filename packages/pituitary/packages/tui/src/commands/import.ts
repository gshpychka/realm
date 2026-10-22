import { constants, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { tilde } from "../place.ts";
import type { CommandContext } from "./run-command.ts";

/** The path `/import` names: its first word, or the text between a pair of quotes. */
export function importArgument(args: string): string | null {
  const text = args.trimStart();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    return end > 1 ? text.slice(1, end) : null;
  }
  return text.split(/\s/)[0] || null;
}

/** `path` made absolute against the working directory, with a leading `~` as the home directory. */
export function resolveImportPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

/** The working directory a stored session names, when that directory is missing. */
export function missingCwd(file: string): string | null {
  const cwd = sessionCwd(file);
  return cwd && !existsSync(cwd) ? cwd : null;
}

/** The working directory a stored session names, or null when it names none. */
export function sessionCwd(file: string): string | null {
  const cwd = headerOf(file)?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : null;
}

function headerOf(file: string): Record<string, unknown> | null {
  try {
    const first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    const header = JSON.parse(first) as unknown;
    return header && typeof header === "object" && (header as { type?: unknown }).type === "session"
      ? (header as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Where an imported session goes in `dir`: `source` itself when it is stored there already,
 * otherwise its name with the first `-N` suffix that names no file.
 */
export function importDestination(source: string, dir: string, fresh = false): string {
  const direct = join(dir, basename(source));
  if (!fresh && resolve(direct) === source) return source;
  const { name, ext } = parse(direct);
  let destination = direct;
  for (let suffix = 1; existsSync(destination); suffix++) destination = join(dir, `${name}-${suffix}${ext}`);
  return destination;
}

/** Copies `source` to `destination`, which must not exist, with the header's working directory set to `cwd` when given. */
export function copySession(source: string, destination: string, cwd?: string): void {
  if (cwd === undefined) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    return;
  }
  const [first = "", ...rest] = readFileSync(source, "utf8").split("\n");
  const header = { ...(JSON.parse(first) as Record<string, unknown>), cwd };
  writeFileSync(destination, [JSON.stringify(header), ...rest].join("\n"), { flag: "wx" });
}

/**
 * Replaces the current session with a copy of the session file `args` names, stored in
 * `dir` beside the current one, once the operator confirms.
 */
export async function importSession(
  args: string,
  dir: string | undefined,
  context: CommandContext,
): Promise<void> {
  const { link, session } = context;
  const given = importArgument(args);
  if (!given) throw new Error("usage: /import <path.jsonl>");
  const source = resolveImportPath(given);
  if (!existsSync(source)) throw new Error(`no session file at ${tilde(source)}`);
  if (!dir) throw new Error("this session has no directory to import into");
  const current = session.state?.sessionFile;
  // pi falls back to its own working directory, which the current session names.
  const fallback = (current && existsSync(current) ? sessionCwd(current) : null) ?? process.cwd();

  const replace = async (cwd?: string) => {
    const destination = importDestination(source, dir, cwd !== undefined);
    const copied = destination !== source;
    if (copied) copySession(source, destination, cwd);
    try {
      const { cancelled } = await link.call({ type: "switch_session", sessionPath: destination });
      if (cancelled) {
        if (copied) rmSync(destination, { force: true });
        session.notify("warning", "an extension kept the session from changing");
        return;
      }
    } catch (cause) {
      if (copied) rmSync(destination, { force: true });
      throw cause;
    }
    await session.refresh();
    session.notify("info", `imported the session from ${tilde(source)}`);
  };
  const failed = (cause: unknown) =>
    session.notify("error", `/import: ${cause instanceof Error ? cause.message : String(cause)}`);
  const cancelled = () => session.notify("info", "import cancelled");

  const gone = missingCwd(source);
  context.pick({
    title: `replace the current session with ${tilde(source)}?`,
    items: [
      { label: "replace it", value: "replace" },
      { label: "keep the current session", value: "keep" },
    ],
    onPick: (answer) => {
      if (answer !== "replace") {
        cancelled();
        return;
      }
      if (!gone) {
        void replace().catch(failed);
        return;
      }
      context.pick({
        title: `the session's directory ${tilde(gone)} does not exist`,
        items: [
          { label: `continue in ${tilde(fallback)}`, value: "continue" },
          { label: "cancel", value: "cancel" },
        ],
        onPick: (choice) => {
          if (choice === "continue") void replace(fallback).catch(failed);
          else cancelled();
        },
        onCancel: cancelled,
      });
    },
    onCancel: cancelled,
  });
}
