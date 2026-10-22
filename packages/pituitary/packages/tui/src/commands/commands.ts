/** A command the operator can run by typing `/name`. */
export interface Command {
  name: string;
  description: string;
  /** Who runs it: this client, or pi on behalf of an extension, prompt template, or skill. */
  source: "builtin" | "extension" | "prompt" | "skill";
  /** A hint at what follows the name, for a command that takes arguments. */
  args?: string;
}

/** Commands this client runs itself; pi runs nothing named like these over RPC. */
export const BUILTINS: readonly Command[] = [
  { name: "model", description: "choose the model", source: "builtin", args: "[provider/id]" },
  { name: "thinking", description: "choose the thinking level", source: "builtin", args: "[level]" },
  { name: "new", description: "start a new session", source: "builtin" },
  { name: "resume", description: "open an earlier session", source: "builtin" },
  { name: "fork", description: "start a new session from an earlier prompt", source: "builtin" },
  { name: "clone", description: "copy this session into a new one", source: "builtin" },
  {
    name: "compact",
    description: "summarise the session to free context",
    source: "builtin",
    args: "[instructions]",
  },
  { name: "name", description: "name this session", source: "builtin", args: "<name>" },
  { name: "session", description: "show the session file, messages, tokens, and cost", source: "builtin" },
  {
    name: "usage",
    description: "how near the subscription's usage limits are, and extra usage",
    source: "builtin",
  },
  { name: "tree", description: "move to another point of the session tree", source: "builtin" },
  {
    name: "reload",
    description: "reload extensions, skills, prompts, themes, and context files",
    source: "builtin",
  },
  { name: "changelog", description: "what changed in the latest version of pi", source: "builtin" },
  { name: "copy", description: "copy the last reply to the clipboard", source: "builtin" },
  { name: "export", description: "export the session as HTML", source: "builtin", args: "[path]" },
  { name: "settings", description: "compaction, retry, and queue settings", source: "builtin" },
  { name: "hotkeys", description: "list the keys", source: "builtin" },
  { name: "quit", description: "quit", source: "builtin" },
  {
    name: "login",
    description: "sign in to a provider, in pi itself",
    source: "builtin",
    args: "[provider]",
  },
  { name: "logout", description: "sign out of a provider, in pi itself", source: "builtin" },
  { name: "share", description: "share the session as a secret gist", source: "builtin" },
  { name: "scoped-models", description: "choose the models ctrl+p cycles", source: "builtin" },
  {
    name: "import",
    description: "replace this session with a session file",
    source: "builtin",
    args: "<path>",
  },
  { name: "trust", description: "trust this project's own files", source: "builtin" },
  { name: "debug", description: "write the screen and messages to a debug log", source: "builtin" },
];

/**
 * Stock pi commands that need pi's own interface: the client hands the terminal to stock
 * pi on the same session, and the operator runs the command there.
 */
export const HANDOFF: ReadonlySet<string> = new Set(["login", "logout"]);

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
