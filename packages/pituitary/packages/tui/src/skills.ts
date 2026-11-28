import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Command } from "./commands/commands.ts";
import { SKILL_COMMAND, SKILL_NAME } from "./user-text.ts";

/** A skill Pi has loaded, which `/skill:name request` runs. */
export interface Skill {
  name: string;
  description: string;
  /** Whose it is: the operator's own, the project's, or only this run's, as `--skill` loads. */
  scope: NonNullable<Command["scope"]>;
  /** Its file, which the model reads to load it. */
  path: string;
}

/** The skills among Pi's commands, by the name `/skill:` takes. */
export function piSkills(commands: readonly Command[]): Skill[] {
  return commands.flatMap((command) =>
    command.source === "skill" && command.path && command.name.startsWith(SKILL_NAME)
      ? [
          {
            name: command.name.slice(SKILL_NAME.length),
            description: command.description,
            scope: command.scope ?? "temporary",
            path: command.path,
          },
        ]
      : [],
  );
}

/**
 * The skill a file the model reads belongs to, by its path as the call gave it; null for any
 * other file. Only a known list of skills says which files are skills: Pi also loads standalone
 * Markdown skills, and a `SKILL.md` the model reads may be one it is editing.
 */
export type SkillOf = (path: string) => string | null;

/**
 * The skill each of `skills`' files belongs to, for a model's reads from `cwd`. Pi's read tool
 * drops a leading `@`, expands `~`, and resolves the rest against its working directory.
 */
export function skillFiles(skills: readonly Skill[], cwd: string, home = homedir()): SkillOf {
  const byPath = new Map(skills.map((skill) => [resolve(skill.path), skill.name]));
  return (path) => {
    const bare = path.replace(/^@/, "");
    const expanded = bare === "~" || bare.startsWith("~/") ? join(home, bare.slice(1)) : bare;
    return byPath.get(isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)) ?? null;
  };
}

/** The skill command `draft` starts with: the name as typed, up to any whitespace, and the rest after it. */
function leading(draft: string): { name: string; rest: string } | null {
  if (!draft.startsWith(SKILL_COMMAND)) return null;
  const after = draft.slice(SKILL_COMMAND.length);
  const name = /^\S*/.exec(after)?.[0] ?? "";
  return { name, rest: after.slice(name.length) };
}

/**
 * `draft` led by `/skill:name `, the rest of it the skill's request; a skill command already
 * leading it is replaced. Pi expands a skill only at the very start of a prompt.
 */
export function withSkill(draft: string, name: string): string {
  return `${SKILL_COMMAND}${name} ${(leading(draft)?.rest ?? draft).trimStart()}`;
}

/** The skill a draft's leading `/skill:` names, as typed; null when it has none. */
export function leadingSkill(draft: string): string | null {
  return leading(draft)?.name || null;
}

/**
 * A skill command later in a draft, after whitespace. `SKILL_COMMAND` holds no character a
 * pattern reads specially.
 */
const LATER = new RegExp(`\\s${SKILL_COMMAND}\\S`);

/**
 * What is wrong with the skill commands in `draft`, given the skills Pi has loaded: Pi
 * expands only a leading `/skill:` naming one of them, reading the name up to the first
 * space, and sends anything else as typed. Null when nothing is; a name still being typed,
 * with nothing after it, is the completion list's to finish.
 */
export function skillFlag(draft: string, names: ReadonlySet<string>): string | null {
  let rest = draft;
  if (draft.startsWith(SKILL_COMMAND)) {
    const space = draft.indexOf(" ");
    const name = draft.slice(SKILL_COMMAND.length, space === -1 ? undefined : space);
    const [first = ""] = name.split(/\s/);
    if (first !== name) {
      const fix =
        name[first.length] === "\n"
          ? `start the request on the ${SKILL_COMMAND}${first} line`
          : `put a plain space after ${SKILL_COMMAND}${first}`;
      return `${fix}: Pi reads the name up to the first space`;
    }
    if (space !== -1 && !name) return `name a skill straight after ${SKILL_COMMAND}`;
    if (space !== -1 && !names.has(name)) return `Pi has no skill ${name}, so it goes as typed`;
    rest = space === -1 ? "" : draft.slice(space);
  }
  return LATER.test(rest) ? `a skill loads only from ${SKILL_COMMAND} at the start of the draft` : null;
}
