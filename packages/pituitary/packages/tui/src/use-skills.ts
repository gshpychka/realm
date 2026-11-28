import { join } from "node:path";
import { type RefObject, useMemo, useState } from "react";
import { type Command, shellCommand } from "./commands/commands.ts";
import type { EditorHandle } from "./components/editor.tsx";
import type { PickerSpec, Tag } from "./components/picker.tsx";
import { piAgentDir, tilde } from "./place.ts";
import { leadingSkill, piSkills, type Skill, skillFiles, skillFlag, withSkill } from "./skills.ts";
import { palette, theme } from "./theme.ts";
import type { SessionController } from "./use-session.ts";

/** How the skill list marks whose each skill is, after its name. */
const SCOPES: Record<Skill["scope"], Tag> = {
  project: { text: "project", colour: theme.user },
  user: { text: "user", colour: palette.muted },
  temporary: { text: "this run", colour: theme.tool },
};

export interface UseSkillsOptions {
  /** Regular Pi's commands, among them its skills; undefined where the skill list is unknown, as in Dura. */
  commands: readonly Command[] | undefined;
  /** Where the model's reads resolve from. */
  cwd: string;
  editor: RefObject<EditorHandle | null>;
  pick(spec: PickerSpec): void;
  notify: SessionController["notify"];
}

/**
 * Pi's skills in the frontend: the list that puts one before the draft, what the draft's
 * skill commands come to, and which files the model reads load a skill.
 */
export function useSkills({ commands, cwd, editor, pick, notify }: UseSkillsOptions) {
  const skills = useMemo(() => (commands ? piSkills(commands) : null), [commands]);
  const names = useMemo(() => skills?.map((skill) => skill.name), [skills]);
  const known = useMemo(() => (names ? new Set(names) : null), [names]);
  const skillOf = useMemo(() => (skills ? skillFiles(skills, cwd) : undefined), [skills, cwd]);
  const [draft, setDraft] = useState("");
  return {
    /** The skill each file the model reads loads; undefined where Pi's skills are unknown, as in Dura. */
    skillOf,
    /** The names `/skill:` takes, for the draft's chip; undefined where Pi's skills are unknown. */
    names,
    /**
     * What is wrong with the draft's skill commands, for the editor's rule. A shell command's
     * words go to the shell, never to Pi's skill expansion.
     */
    flag: known && !shellCommand(draft) ? skillFlag(draft, known) : null,
    /** Takes the draft as it changes. */
    follow: setDraft,
    /** Opens the list of skills, filtered by `query`; false where Pi's skills are unknown. */
    open(query = ""): boolean {
      if (!skills) return false;
      if (!skills.length) {
        notify(
          "info",
          `Pi has loaded no skills. Add one as ${tilde(join(piAgentDir(), "skills"))}/<name>/SKILL.md, or under .pi/skills in the project, then /reload.`,
        );
        return true;
      }
      const current = leadingSkill(editor.current?.text() ?? "");
      pick({
        title: "skills · the draft becomes the request",
        items: skills.map((skill) => ({
          label: skill.name,
          detail: skill.description,
          tag: SCOPES[skill.scope],
          value: skill.name,
          current: skill.name === current,
        })),
        ...(query ? { query } : {}),
        onPick: (name) => {
          const draft = editor.current;
          draft?.set(withSkill(draft.text(), name));
        },
      });
      return true;
    },
  };
}
