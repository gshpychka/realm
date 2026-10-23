/** A terminal command, completed by name in the editor. */
export interface Command {
  name: string;
  description: string;
  source: "builtin";
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
  { name: "quit", description: "detach from this run", source: "builtin" },
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
