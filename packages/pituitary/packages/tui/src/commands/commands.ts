import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import { SKILL_NAME } from "../user-text.ts";

/**
 * A terminal command, completed by name in the editor: Pituitary's own, or one Pi's extensions,
 * prompt templates or skills register.
 */
export interface Command {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  /** What follows the name: `<required>` or `[optional]`. */
  args?: string;
  /** Whose a Pi command is: the operator's own, the project's, or only this run's, as `--skill` loads. */
  scope?: SourceInfo["scope"];
  /** The file Pi loaded a Pi command from, such as a skill's `SKILL.md`. */
  path?: string;
}
export const BUILTINS: readonly Command[] = [
  { name: "model", description: "choose an available model", source: "builtin", args: "[provider/id]" },
  { name: "thinking", description: "choose the thinking level", source: "builtin", args: "[level]" },
  {
    name: "compact",
    description: "summarise the conversation to free context",
    source: "builtin",
    args: "[instructions]",
  },
  { name: "name", description: "name this conversation", source: "builtin", args: "<name>" },
  {
    name: "session",
    description: "show this session's file, messages, context and cost",
    source: "builtin",
    args: "[copy]",
  },
  { name: "copy", description: "copy the last reply", source: "builtin" },
  { name: "hotkeys", description: "list the keys", source: "builtin" },
  { name: "quit", description: "close the frontend", source: "builtin" },
];

/** Regular Pi's session commands, which Pituitary runs without leaving its screen. */
export const SESSION_COMMANDS: readonly Command[] = [
  { name: "new", description: "start a new session", source: "builtin" },
  {
    name: "resume",
    description: "switch to a saved session; all lists every project's",
    source: "builtin",
    args: "[all]",
  },
  { name: "fork", description: "start a new session from an earlier prompt", source: "builtin" },
  {
    name: "tree",
    description: "move to another point of this session; where you were stays as a branch",
    source: "builtin",
  },
  { name: "clone", description: "copy this session into a new one", source: "builtin" },
  {
    name: "reload",
    description: "reload Pi's extensions, skills, prompts and context files",
    source: "builtin",
  },
  { name: "export", description: "write this session as an HTML page", source: "builtin", args: "[path]" },
];

/** What follows a skill's command: the request its instructions frame. */
export const SKILL_REQUEST = "[request]";

/** Regular Pi's list of skills, which puts the chosen one before the draft. */
export const SKILLS: Command = {
  name: "skills",
  description: "choose a skill; the draft becomes its request",
  source: "builtin",
  args: "[filter]",
};

/** Regular Pi's second opinion: other models weigh in on the conversation, read-only. */
export const CONSULT: Command = {
  name: "consult",
  description: "ask other models for a second opinion; cancel stops them",
  source: "builtin",
  args: "[question|cancel]",
};

/** Pi's own screens: Pituitary hands them the terminal and comes back when they close. */
export const PI_SCREENS: readonly Command[] = [
  { name: "login", description: "connect a provider or subscription · opens Pi", source: "builtin" },
  { name: "logout", description: "disconnect a provider · opens Pi", source: "builtin" },
  { name: "settings", description: "change Pi settings · opens Pi", source: "builtin" },
  { name: "scoped-models", description: "choose models for cycling · opens Pi", source: "builtin" },
  { name: "trust", description: "manage project trust · opens Pi", source: "builtin" },
  { name: "import", description: "import a session file · opens Pi", source: "builtin" },
  { name: "share", description: "share this session · opens Pi", source: "builtin" },
];

/** The command among `commands` that `text` runs, with what follows its name; `null` when none. */
export function named(
  text: string,
  commands: readonly Pick<Command, "name">[],
): { name: string; args: string } | null {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name || !commands.some((command) => command.name === name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}

/**
 * The shell command a draft runs, as Pi's own editor reads one: `!command` gives its output to
 * the model with the next prompt, `!!command` keeps it out. `null` for any other draft; an
 * empty command when nothing follows the marks.
 */
export function shellCommand(text: string): { command: string; excluded: boolean } | null {
  const draft = text.trim();
  if (!draft.startsWith("!")) return null;
  const excluded = draft.startsWith("!!");
  return { command: draft.slice(excluded ? 2 : 1).trim(), excluded };
}

/** The built-in command `text` runs, with what follows its name; `null` when pi should receive it. */
export function builtin(text: string): { name: string; args: string } | null {
  return named(text, BUILTINS);
}

/** The name being typed after `/`, while no arguments follow it; null otherwise. */
export function typedName(text: string): string | null {
  return /^\/(\S*)$/.exec(text)?.[1] ?? null;
}

/** The names a command is found by: a skill's also without its `skill:`, so `/pdf` finds `skill:pdf-tools`. */
function namesOf(command: Command): string[] {
  const name = command.name.toLowerCase();
  return command.source === "skill" && name.startsWith(SKILL_NAME)
    ? [name, name.slice(SKILL_NAME.length)]
    : [name];
}

/**
 * Commands matching the name being typed: the one named exactly, then those starting with it,
 * then those holding it. `null` once arguments begin.
 */
export function suggest(text: string, commands: readonly Command[], limit = 100): Command[] | null {
  const name = typedName(text);
  if (name === null) return null;
  const typed = name.toLowerCase();
  const rank = (command: Command) => {
    const names = namesOf(command);
    if (command.name.toLowerCase() === typed) return 0;
    if (names.some((each) => each.startsWith(typed))) return 1;
    return names.some((each) => each.includes(typed)) ? 2 : null;
  };
  return commands
    .flatMap((command) => {
      const at = rank(command);
      return at === null ? [] : [{ command, at }];
    })
    .sort((a, b) => a.at - b.at)
    .map(({ command }) => command)
    .slice(0, limit);
}
