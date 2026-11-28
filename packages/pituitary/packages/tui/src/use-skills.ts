import { homedir } from "node:os";
import { join } from "node:path";
import { type RefObject, useMemo, useState } from "react";
import type { Command } from "./commands/commands.ts";
import type { DetailIcon } from "./components/detail.tsx";
import type { EditorHandle } from "./components/editor.tsx";
import type { PickerSpec } from "./components/picker.tsx";
import { tilde } from "./place.ts";
import {
  leadingSkill,
  piSkills,
  type Skill,
  type SkillOf,
  skillByFileName,
  skillFiles,
  skillFlag,
  withSkill,
} from "./skills.ts";
import { palette, theme } from "./theme.ts";
import type { SessionController } from "./use-session.ts";

/** How the skill list marks whose each skill is, ahead of its description. */
const SCOPES: Record<Skill["scope"], DetailIcon> = {
  project: { glyph: "project", colour: theme.user },
  user: { glyph: "user", colour: palette.muted },
  temporary: { glyph: "this run", colour: theme.tool },
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
  const skillOf = useMemo<SkillOf>(() => (skills ? skillFiles(skills, cwd) : skillByFileName), [skills, cwd]);
  const [draft, setDraft] = useState("");
  return {
    /** The skill each file the model reads loads. */
    skillOf,
    /** The names `/skill:` takes, for the draft's chip; undefined where Pi's skills are unknown. */
    names,
    /** What is wrong with the draft's skill commands, for the editor's rule. */
    flag: known ? skillFlag(draft, known) : null,
    /** Takes the draft as it changes. */
    follow: setDraft,
    /** Opens the list of skills, filtered by `query`; false where Pi's skills are unknown. */
    open(query = ""): boolean {
      if (!skills) return false;
      if (!skills.length) {
        const agent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
        notify(
          "info",
          `Pi has loaded no skills. Add one as ${tilde(join(agent, "skills"))}/<name>/SKILL.md, or under .pi/skills in the project, then /reload.`,
        );
        return true;
      }
      const current = leadingSkill(editor.current?.text() ?? "");
      pick({
        title: "skills · the draft becomes the request",
        items: skills.map((skill) => ({
          label: skill.name,
          detail: skill.description,
          icon: SCOPES[skill.scope],
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
