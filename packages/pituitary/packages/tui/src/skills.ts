import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Command } from "./commands/commands.ts";
import { SKILL_COMMAND } from "./user-text.ts";

/** A skill Pi has loaded, which `/skill:name request` runs. */
export interface Skill {
  name: string;
  description: string;
  /** Whose it is: the operator's own, the project's, or only this run's, as `--skill` loads. */
  scope: NonNullable<Command["scope"]>;
  /** Its file, which the model reads to load it. */
  path: string;
}

/** What the name of a skill's command starts with, as Pi names it. */
const SKILL_NAME = "skill:";

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

/** The skill a file the model reads belongs to, by its path as the call gave it; null for any other file. */
export type SkillOf = (path: string) => string | null;

/** The file holding a skill in a directory of its own, as the Agent Skills specification names it. */
const SKILL_FILE = "SKILL.md";

/**
 * Where the skill list is unknown, as in Dura, a `SKILL.md` is taken for the skill its
 * directory is named after. Pi also loads standalone Markdown skills, which only a known list finds.
 */
export const skillByFileName: SkillOf = (path) =>
  basename(path) === SKILL_FILE ? basename(dirname(path)) || null : null;

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

/** The `/skill:name` command a draft starts with, and the rest after it. */
const LEADING = /^\/skill:(\S*)[ \t]*/;

/**
 * `draft` led by `/skill:name `, the rest of it the skill's request; a skill command already
 * leading it is replaced. Pi expands a skill only at the very start of a prompt.
 */
export function withSkill(draft: string, name: string): string {
  return `${SKILL_COMMAND}${name} ${draft.replace(LEADING, "").trimStart()}`;
}

/** The skill a draft's leading `/skill:` names, as typed; null when it has none. */
export function leadingSkill(draft: string): string | null {
  return LEADING.exec(draft)?.[1] || null;
}

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
    if (first !== name) return `add a space after /skill:${first}: Pi reads the name up to one`;
    if (space !== -1 && !name) return "name a skill straight after /skill:";
    if (space !== -1 && !names.has(name)) return `Pi has no skill ${name}, so it goes as typed`;
    rest = space === -1 ? "" : draft.slice(space);
  }
  return /\s\/skill:\S/.test(rest) ? "a skill loads only from /skill: at the start of the draft" : null;
}
