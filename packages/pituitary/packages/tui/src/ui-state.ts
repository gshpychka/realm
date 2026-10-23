import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { ConversationState } from "./components/team.tsx";

export const RELOAD_UI = 75;
export interface ManagedView {
  taskId: string;
  control: boolean;
  views: Record<string, ConversationState>;
}

/** Frontend drafts and viewport state belong to the operator, never to conversation history. */
export function readManagedView(path: string | undefined): ManagedView | undefined {
  if (!path) return;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.uid !== process.getuid?.() || file.size > 2 * 1024 * 1024) return;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("taskId" in parsed) ||
      typeof parsed.taskId !== "string" ||
      !("views" in parsed) ||
      !parsed.views ||
      typeof parsed.views !== "object"
    )
      return;
    const views: ManagedView["views"] = {};
    for (const [id, value] of Object.entries(parsed.views).slice(0, 512)) {
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.draft !== "string" ||
        value.draft.length > 512 * 1024 ||
        !Number.isSafeInteger(value.cursor) ||
        value.cursor < 0 ||
        value.cursor > value.draft.length ||
        !(
          value.scrollTop === null ||
          (typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0)
        ) ||
        !Number.isSafeInteger(value.window) ||
        value.window < 1 ||
        value.window > 1_000_000 ||
        typeof value.expanded !== "boolean" ||
        typeof value.thinking !== "boolean"
      )
        continue;
      views[id] = {
        draft: value.draft,
        cursor: value.cursor,
        scrollTop: value.scrollTop,
        window: value.window,
        expanded: value.expanded,
        thinking: value.thinking,
      };
    }
    return { taskId: parsed.taskId, control: "control" in parsed && parsed.control === true, views };
  } catch {
    return;
  }
}

export function writeManagedView(path: string | undefined, view: ManagedView): void {
  if (!path) return;
  const temporary = `${path}.${process.pid}.tmp`;
  const bytes = JSON.stringify(view);
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024)
    throw new Error("Frontend drafts exceed their saved size limit");
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed successfully, or no temporary file was created. */
    }
  }
}

/** Reload the frontend while native conversations continue in the host. */
export function watchFrontend(reload: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const roots = [
    import.meta.dirname,
    ...["session", "ember"].map((name) => new URL(`../../${name}/src/`, import.meta.url).pathname),
  ];
  const watchers = roots.map((root) =>
    watch(root, { recursive: true }, (_event, name) => {
      if (!name || !/\.(ts|tsx)$/.test(String(name)) || /\.(test|fixture)\./.test(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 150);
    }),
  );
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
