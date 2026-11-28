import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a key can do, named as pi names its keybinding actions. */
export const ACTIONS = {
  "app.team.tasks": ["ctrl+k"],
  "app.team.back": ["alt+left"],
  "app.team.attention": ["ctrl+q"],
  "app.team.join": ["alt+i"],
  "app.ui.reload": ["ctrl+r"],
  "app.session.new": ["alt+n"],
  "app.session.resume": ["alt+r"],
  "app.session.fork": ["alt+f"],
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
  /**
   * pituitary's own: opens and closes the footer's card of provider usage and session cost.
   * Like pi's alt keys it takes a chord nvim's insert mode reads as esc then u. Where the terminal
   * delivers a quick esc u as that chord, as one without the kitty keyboard protocol may, it
   * toggles the card instead of undoing.
   */
  "app.usage.toggle": ["alt+u"],
} as const satisfies Record<string, readonly string[]>;

/**
 * What a key does inside the resume list, named as pi names these actions. As in pi, they may
 * share keys with the actions above, which apply everywhere else.
 */
export const LIST_ACTIONS = {
  "app.session.rename": ["ctrl+r"],
  /** pi binds delete to ctrl+d, which closes Pituitary everywhere else; ctrl+x deletes here. */
  "app.session.delete": ["ctrl+x"],
  /** Switches the list between this project's sessions and every project's, as pi's does. */
  "tui.input.tab": ["tab"],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof ACTIONS;
export type ListAction = keyof typeof LIST_ACTIONS;
export type Keymap = Record<Action | ListAction, readonly string[]>;

/** Whether `action` applies only inside the resume list. */
export const isListAction = (action: string): action is ListAction => Object.hasOwn(LIST_ACTIONS, action);

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
  ["kpenter", "return"],
  ["pgup", "pageup"],
  ["pgdn", "pagedown"],
]);

/** True when `key` is the key `binding` describes, such as `ctrl+l` or `alt+enter`. */
export function matches(key: KeyLike, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  const mods = new Set(parts);
  if (!name || [...mods].some((mod) => !["ctrl", "alt", "meta", "shift"].includes(mod))) return false;
  const want = ALIASES.get(name) ?? name;
  const actual = ALIASES.get(key.name) ?? key.name;
  return (
    actual === want &&
    Boolean(key.ctrl) === mods.has("ctrl") &&
    Boolean(key.meta) === (mods.has("alt") || mods.has("meta")) &&
    Boolean(key.shift) === mods.has("shift")
  );
}

/** The action `key` triggers outside lists, if any. */
export function actionFor(keymap: Keymap, key: KeyLike): Action | null {
  for (const action of Object.keys(ACTIONS) as Action[]) {
    if (keymap[action].some((binding) => matches(key, binding))) return action;
  }
  return null;
}

/**
 * The default bindings with the operator's overrides from `keybindings.json`, which
 * maps an action to a key or a list of keys. An override for an action replaces its defaults.
 */
export function keymap(overrides: Record<string, unknown> = {}): Keymap {
  const map: Keymap = { ...ACTIONS, ...LIST_ACTIONS };
  type Named = keyof Keymap;
  // A key belongs to one action everywhere outside lists, and to one inside the resume list.
  const claim = (action: Named, key: string) => `${isListAction(action) ? "list" : "app"} ${bindingId(key)}`;
  const assigned = new Map<string, Named>();
  for (const [action, value] of Object.entries(overrides)) {
    const keys = keysOf(value);
    if (Object.hasOwn(map, action) && keys) {
      map[action as Named] = keys;
      for (const key of keys) assigned.set(claim(action as Named, key), action as Named);
    }
  }
  // A deliberate binding wins over another action's default, including actions later in
  // the table. Otherwise assigning a key can look valid in /hotkeys while doing something else.
  for (const action of Object.keys(map) as Named[]) {
    map[action] = map[action].filter((key) => {
      const owner = assigned.get(claim(action, key));
      return owner === undefined || owner === action;
    });
  }
  return map;
}

/** A binding's identity, independent of modifier order and accepted aliases. */
function bindingId(binding: string): string {
  const parts = binding.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  const mods = [...new Set(parts.map((part) => (part === "meta" ? "alt" : part)))].sort();
  return [...mods, ALIASES.get(name) ?? name].join("+");
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

/** The operator's terminal bindings. */
export function loadKeymap(own = ownKeybindingsFile()): Keymap {
  return keymap(readBindings(own));
}

/** Regular Pi's terminal actions, with Pituitary's explicit overrides applied last. */
export function loadPiKeymap(
  base = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "keybindings.json"),
  own = ownKeybindingsFile(),
): Keymap {
  return keymap({ ...readBindings(base), ...readBindings(own) });
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
