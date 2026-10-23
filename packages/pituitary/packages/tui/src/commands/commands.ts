/** A terminal command, completed by name in the editor. */
export interface Command {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt";
  args?: string;
  localOnly?: boolean;
}
export const BUILTINS: readonly Command[] = [
  {
    name: "model",
    description: "choose an available model",
    source: "builtin",
    args: "[provider/id]",
    localOnly: true,
  },
  { name: "thinking", description: "choose the thinking level", source: "builtin", args: "[level]" },
  {
    name: "compact",
    description: "summarise the conversation to free context",
    source: "builtin",
    args: "[instructions]",
  },
  { name: "name", description: "name this conversation", source: "builtin", args: "<name>" },
  { name: "session", description: "show messages, tokens and cost", source: "builtin" },
  { name: "copy", description: "copy the last reply", source: "builtin" },
  { name: "hotkeys", description: "list the keys", source: "builtin" },
  { name: "quit", description: "close the frontend", source: "builtin" },
];

export const PI_COMMANDS: readonly Command[] = [
  { name: "login", description: "connect a provider or subscription", source: "builtin" },
  { name: "logout", description: "disconnect a provider", source: "builtin" },
  { name: "new", description: "start a new Pi session", source: "builtin" },
  { name: "resume", description: "resume a Pi session", source: "builtin" },
  { name: "fork", description: "branch from an earlier message", source: "builtin" },
  { name: "clone", description: "duplicate this Pi session", source: "builtin" },
  { name: "tree", description: "navigate the session tree", source: "builtin" },
  { name: "settings", description: "open Pi settings", source: "builtin" },
  { name: "scoped-models", description: "choose models for cycling", source: "builtin" },
  { name: "reload", description: "reload Pi resources", source: "builtin" },
  { name: "trust", description: "manage project trust", source: "builtin" },
  { name: "export", description: "export the Pi session", source: "builtin" },
  { name: "import", description: "import a Pi session", source: "builtin" },
  { name: "share", description: "share the Pi session", source: "builtin" },
];

/** The built-in command `text` runs, with what follows its name; `null` when pi should receive it. */
export function builtin(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  const name = match[1];
  if (!BUILTINS.some((command) => command.name === name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}

/** Commands matching the name being typed, prefix matches first. `null` once arguments begin. */
export function suggest(text: string, commands: readonly Command[], limit = 100): Command[] | null {
  const match = /^\/(\S*)$/.exec(text);
  if (!match) return null;
  const typed = (match[1] ?? "").toLowerCase();
  const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(typed));
  const inside = commands.filter(
    (command) => !command.name.toLowerCase().startsWith(typed) && command.name.toLowerCase().includes(typed),
  );
  return [...prefix, ...inside].slice(0, limit);
}
