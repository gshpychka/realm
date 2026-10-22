import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a key can do, named as pi names its keybinding actions. */
export const ACTIONS = {
  "app.interrupt": ["escape"],
  "app.clear": ["ctrl+c"],
  "app.exit": ["ctrl+d"],
  "app.message.followUp": ["alt+enter"],
  "app.message.dequeue": ["up"],
  "app.tools.expand": ["ctrl+o"],
  /** pituitary's own: steps through the boxes of thinking and tool calls from the keyboard. */
  "app.tools.browse": ["ctrl+f"],
  "app.thinking.toggle": ["ctrl+t"],
  "app.thinking.cycle": ["shift+tab"],
  "app.editor.external": ["ctrl+g"],
  "app.message.copy": ["ctrl+x"],
  "app.suspend": ["ctrl+z"],
  "app.model.select": ["ctrl+l"],
  "app.model.cycleForward": ["ctrl+p"],
  "app.session.new": [],
  "app.session.resume": [],
  "app.session.fork": [],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof ACTIONS;
export type Keymap = Record<Action, readonly string[]>;

/** The parts of a key event a binding is matched against. */
export interface KeyLike {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Names a binding may use for a key, mapped to the name the key event carries. */
const ALIASES = new Map([
  ["esc", "escape"],
  ["enter", "return"],
  ["pgup", "pageup"],
  ["pgdn", "pagedown"],
]);

/** True when `key` is the key `binding` describes, such as `ctrl+l` or `alt+enter`. */
export function matches(key: KeyLike, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  const mods = new Set(parts);
  const want = ALIASES.get(name) ?? name;
  // Terminals report shift+tab as a key of its own.
  if (want === "tab" && mods.has("shift") && key.name === "tab" && key.shift) return !key.ctrl && !key.meta;
  return (
    key.name === want &&
    Boolean(key.ctrl) === mods.has("ctrl") &&
    Boolean(key.meta) === (mods.has("alt") || mods.has("meta")) &&
    Boolean(key.shift) === mods.has("shift")
  );
}

/** The action `key` triggers, if any. */
export function actionFor(keymap: Keymap, key: KeyLike): Action | null {
  for (const [action, bindings] of Object.entries(keymap) as [Action, readonly string[]][]) {
    if (bindings.some((binding) => matches(key, binding))) return action;
  }
  return null;
}

/**
 * The default bindings with the operator's overrides from `keybindings.json`, which
 * maps an action to a key or a list of keys. An override for an action replaces its defaults.
 */
export function keymap(overrides: Record<string, unknown> = {}): Keymap {
  const map = { ...ACTIONS } as Keymap;
  for (const [action, value] of Object.entries(overrides)) {
    const keys = keysOf(value);
    if (action in ACTIONS && keys) map[action as Action] = keys;
  }
  return map;
}

/** An override's keys: one key, or a list of them; anything else overrides nothing. */
function keysOf(value: unknown): readonly string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((key) => typeof key === "string");
  return null;
}

/** pituitary's own keybindings file, which overrides pi's action by action. */
export function ownKeybindingsFile(): string {
  return (
    process.env.PITUITARY_KEYBINDINGS ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pituitary", "keybindings.json")
  );
}

/** The operator's keymap: pi's `keybindings.json`, then pituitary's own file over it. */
export function loadKeymap(
  agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  own = ownKeybindingsFile(),
): Keymap {
  return keymap({ ...readBindings(join(agentDir, "keybindings.json")), ...readBindings(own) });
}

/** A keybindings file's action map; empty when the file is absent or malformed. */
function readBindings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
