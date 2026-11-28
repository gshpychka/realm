import { basename } from "node:path";
import type { AssistantEntry, Entry, ToolView } from "@pituitary/session";
import { detailsOf } from "./details.ts";
import { counted } from "./plural.ts";
import type { SkillOf } from "./skills.ts";
import { ellipsize } from "./text-width.ts";
import { heading } from "./tools.ts";

/** One thing the model did on its way to a reply, in the order it did it. */
export type Step =
  /** Reasoning; `done` once the model wrote anything after it, or ended the reply it began. */
  | { kind: "thinking"; id: string; text: string; done: boolean }
  /** Words written before a tool call: narration of the work, not the reply. */
  | { kind: "text"; id: string; text: string }
  /** A call, with the skill it loads when it reads a skill's file. */
  | { kind: "tool"; id: string; tool: ToolView; skill?: string };

/** The thinking, narration, and tool calls of consecutive replies, drawn together in one box. */
export interface Work {
  kind: "work";
  id: string;
  steps: Step[];
  /**
   * The model is still working in it: the run goes on, and the reply after the box, while it is
   * still being written, may yet call a tool from it.
   */
  live: boolean;
  /**
   * The conversation's latest work, with nothing the operator sent after it yet. It keeps
   * showing its latest steps until something is, so the end of a run moves nothing on screen.
   */
  latest: boolean;
}

/** Why a reply stopped short: a limit the operator may act on, or the operator's own interruption. */
export interface StopNote {
  text: string;
  tone: "warning" | "quiet";
}

/** What the model says to the operator once its work is done. */
export interface Reply {
  kind: "reply";
  id: string;
  text: string;
  streaming: boolean;
  /** Why the reply stopped short, when it did. */
  note?: StopNote;
}

/** What the conversation draws: entries as they are, with each stretch of replies split into work and reply. */
export type Item = Exclude<Entry, AssistantEntry> | Work | Reply;

/** Stop reasons worth telling the operator about; the rest end a reply normally. */
const STOP_NOTES = new Map<string, StopNote>([
  [
    "length",
    { text: "the reply reached the output limit and stopped · ask it to continue", tone: "warning" },
  ],
  ["aborted", { text: "interrupted", tone: "quiet" }],
]);

/** Steps a box shows while the model works in it, its latest, one row each. */
export const LIVE_STEPS = 3;

/**
 * `entries` as the conversation draws them, while a run goes on when `running`. A read of a
 * file `skillOf` names loads that skill; without a list of skills, as in Dura, no read does.
 */
export function transcriptOf(entries: readonly Entry[], running: boolean, skillOf?: SkillOf): Item[] {
  const items: Item[] = [];
  let stretch: AssistantEntry[] = [];
  const close = (live: boolean) => {
    items.push(...split(stretch, live, skillOf));
    stretch = [];
  };
  for (const entry of entries) {
    if (entry.kind === "assistant") stretch.push(entry);
    else {
      close(false);
      items.push(entry);
    }
  }
  close(running);
  // The operator's own prompt or command after the latest work is what folds it.
  const last = items.findLastIndex((item) => item.kind === "work");
  const work = items[last];
  if (
    work?.kind === "work" &&
    !items.slice(last + 1).some((item) => item.kind === "user" || item.kind === "bash")
  )
    items[last] = { ...work, latest: true };
  return items;
}

/**
 * A stretch of consecutive replies as boxes of work and the replies after them. Everything up
 * to the stretch's last tool call is one box, the words in it narration; the reply after that
 * call answers it, its thinking in the box. Any reply after that one stands on its own: words
 * that no tool call followed were said to the operator.
 */
function split(stretch: readonly AssistantEntry[], running: boolean, skillOf: SkillOf | undefined): Item[] {
  const called = stretch.findLastIndex((entry) => entry.tools.length > 0);
  const answers = called < 0 ? stretch : stretch.slice(called + 1);
  const units = [
    ...(called < 0 ? [] : [{ work: stretch.slice(0, called + 1), answer: answers[0] }]),
    ...(called < 0 ? answers : answers.slice(1)).map((answer) => ({ work: [], answer })),
  ];
  return units.flatMap(({ work, answer }, index) =>
    unit(work, answer, running && index === units.length - 1, skillOf),
  );
}

/** One box of work, when there is any, and the reply that answers it. */
function unit(
  work: readonly AssistantEntry[],
  answer: AssistantEntry | undefined,
  running: boolean,
  skillOf: SkillOf | undefined,
): Item[] {
  const steps = [
    ...work.flatMap((entry): Step[] => [
      ...thought(entry),
      ...(entry.text ? [{ kind: "text", id: `${entry.id}:text`, text: entry.text } as const] : []),
      ...entry.tools.map((tool): Step => {
        const skill = loads(tool, skillOf);
        return skill ? { kind: "tool", id: tool.id, tool, skill } : { kind: "tool", id: tool.id, tool };
      }),
    ]),
    ...(answer ? thought(answer) : []),
  ];
  const items: Item[] = [];
  const first = steps[0];
  if (first)
    items.push({
      kind: "work",
      id: first.id,
      steps,
      // Words still arriving may yet lead to a tool call, so the box waits on the reply after it.
      live: running && !answer?.done,
      latest: false,
    });
  const last = answer ?? work.at(-1);
  const note = last?.stopReason ? STOP_NOTES.get(last.stopReason) : undefined;
  if (last && (answer?.text || note))
    items.push({ kind: "reply", id: last.id, text: answer?.text ?? "", streaming: !last.done, note });
  return items;
}

const thought = (entry: AssistantEntry): Step[] =>
  entry.thinking
    ? [
        {
          kind: "thinking",
          id: `${entry.id}:thinking`,
          text: entry.thinking,
          done: entry.done || entry.text !== "" || entry.tools.length > 0,
        },
      ]
    : [];

/** The skill `tool` loads: a read of a skill's file, as `skillOf` knows them. */
function loads(tool: ToolView, skillOf: SkillOf | undefined): string | null {
  const path = tool.args.path;
  return skillOf && tool.name === "read" && typeof path === "string" ? skillOf(path) : null;
}

/** A part of what a box of work comes to; one saying what failed draws in the error colour. */
export interface Said {
  text: string;
  failed?: boolean;
}

type Kind = "read" | "search" | "edit" | "write" | "run";

/** How a summary groups a tool's calls, by tool name; it names any other tool as it is. */
const KINDS = new Map<string, Kind>([
  ["read", "read"],
  ["grep", "search"],
  ["find", "search"],
  ["ls", "search"],
  ["edit", "edit"],
  ["write", "write"],
  ["bash", "run"],
]);

/** The kinds in the order a summary says them. */
const ORDER: readonly Kind[] = [...new Set(KINDS.values())];

/** How a summary words each kind of call: once the calls are done, and while they run. */
const VERBS: Record<Kind, { done: string; going: string }> = {
  read: { done: "read", going: "reading" },
  search: { done: "searched", going: "searching" },
  edit: { done: "edited", going: "editing" },
  write: { done: "wrote", going: "writing" },
  run: { done: "ran", going: "running" },
};

/** Files a summary names one by one; it counts more than this many. */
const NAMED_FILES = 2;
/** Cells of a lone command a summary shows, which leaves what follows it room. */
const COMMAND_CELLS = 40;

/**
 * What a box of work comes to, in its own terms, such as `read 4 files · searched 2 · edited
 * footer.tsx +12 −3 · ran 3 commands · 1 failed`, and then what it is doing, such as `running a
 * command`. Thinking alone is `thought`, or `thinking…` while it goes on. A skill is used once a
 * read of its file has succeeded; a skill whose every read failed never reached the model, so the
 * box says that skill failed instead. Every other failed call counts among the failed, but for
 * one the operator's interruption ended, which counts among the interrupted. A lone command is
 * named by its first line, unless the box shows its latest steps, where its own row says it.
 */
export function summary(work: Work): Said[] {
  const calls = work.steps.filter((step) => step.kind === "tool");
  const skillsOf = (keep: (skill: string, tool: ToolView) => boolean) =>
    new Set(calls.flatMap(({ skill, tool }) => (skill && keep(skill, tool) ? [skill] : [])));
  const used = skillsOf((_, tool) => tool.state === "ok");
  const loading = skillsOf((skill, tool) => tool.state === "running" && !used.has(skill));
  const missed = skillsOf((skill) => !used.has(skill) && !loading.has(skill));
  const ended = calls.filter(
    (step) => step.tool.state === "error" && !(step.skill && missed.has(step.skill)),
  );
  const interrupted = ended.filter((step) => step.tool.interrupted).length;
  const failed = ended.length - interrupted;
  const named = (skills: ReadonlySet<string>) =>
    `${skills.size === 1 ? "skill" : "skills"} ${[...skills].join(", ")}`;
  const tools = calls.filter((step) => !step.skill).map((step) => step.tool);
  const others = Map.groupBy(
    tools.filter((tool) => !KINDS.has(tool.name)),
    (tool) => tool.name || "tool",
  );
  // A box showing its latest steps says its lone command on that command's own row.
  const rows = work.live || work.latest;
  /** What the calls of `kind` come to: those done, or those still `going`. */
  const said = (kind: Kind, going: boolean): string | null => {
    const each = tools.filter(
      (tool) => KINDS.get(tool.name) === kind && (tool.state === "running") === going,
    );
    const verb = VERBS[kind][going ? "going" : "done"];
    switch (kind) {
      case "search":
        return each.length === 0 ? null : each.length === 1 ? verb : `${verb} ${each.length}`;
      case "run":
        return ran(verb, each, !going && !rows);
      case "edit":
        return files(verb, each, going ? "" : diffstat(each));
      default:
        return files(verb, each);
    }
  };
  const done = [
    used.size > 0 ? `used ${named(used)}` : null,
    ...ORDER.map((kind) => said(kind, false)),
    ...[...others].map(([name, each]) => (each.length === 1 ? name : `${name} ×${each.length}`)),
  ].filter((part) => part !== null);
  const going = [
    loading.size > 0 ? `loading ${named(loading)}` : null,
    ...ORDER.map((kind) => said(kind, true)),
  ].filter((part) => part !== null);
  const last = work.steps.at(-1);
  const parts: Said[] = [
    ...(done.length === 0 &&
    going.length === 0 &&
    missed.size === 0 &&
    work.steps.some((step) => step.kind === "thinking")
      ? [{ text: last?.kind === "thinking" && !last.done ? "thinking…" : "thought" }]
      : []),
    ...done.map((text) => ({ text })),
    ...(missed.size > 0 ? [{ text: `${named(missed)} failed`, failed: true }] : []),
    ...(failed > 0 ? [{ text: `${failed} failed`, failed: true }] : []),
    ...(interrupted > 0 ? [{ text: `${interrupted} interrupted` }] : []),
    ...going.map((text) => ({ text })),
  ];
  return parts.length > 0 ? parts : [{ text: counted(work.steps.length, "step") }];
}

/** `verb` with the files `calls` acted on, by name or by count, and how they changed. */
function files(verb: string, calls: readonly ToolView[], change = ""): string | null {
  if (calls.length === 0) return null;
  const paths = [...new Set(calls.map((tool) => (typeof tool.args.path === "string" ? tool.args.path : "")))];
  const which =
    paths.length <= NAMED_FILES && paths.every(Boolean)
      ? paths.map((path) => basename(path)).join(", ")
      : counted(paths.length, "file");
  return `${verb} ${which}${change}`;
}

/** The lines edits' diffs add and take away, as ` +12 −3`, once any diff is known. */
function diffstat(edits: readonly ToolView[]): string {
  const diffs = edits.flatMap((tool) => {
    const details = detailsOf(tool);
    return details?.kind === "diff" ? [details.diff] : [];
  });
  if (diffs.length === 0) return "";
  const lines = diffs.flatMap((diff) => diff.split("\n"));
  const count = (sign: string) => lines.filter((line) => line.startsWith(sign)).length;
  return ` +${count("+")} −${count("-")}`;
}

/** `verb` with the commands: how many, or the one by its first line when `name`. */
function ran(verb: string, commands: readonly ToolView[], name: boolean): string | null {
  const [only] = commands;
  if (!only) return null;
  if (commands.length > 1) return `${verb} ${counted(commands.length, "command")}`;
  const line = name ? (heading(only).detail.split("\n")[0]?.trim() ?? "") : "";
  return line ? `${verb} ${ellipsize(line, COMMAND_CELLS)}` : `${verb} a command`;
}

/** The latest steps a box shows while the model works in it, and how many came before them. */
export function rail(work: Work): { steps: Step[]; earlier: number } {
  const steps = work.steps.slice(-LIVE_STEPS);
  return { steps, earlier: work.steps.length - steps.length };
}

/** The box's steps as text, for the clipboard: thinking and narration as written, each call with its result. */
export function workText(work: Work): string {
  return work.steps
    .map((step) => {
      if (step.kind !== "tool") return step.text;
      const { title, detail } = step.skill ? { title: "skill", detail: step.skill } : heading(step.tool);
      const details = detailsOf(step.tool);
      // A file read is the model's to read, so the box leaves its text out; a failed one says why.
      const result =
        details?.kind === "diff"
          ? details.diff
          : step.tool.name === "read" && step.tool.state !== "error"
            ? ""
            : step.tool.output;
      return [`${title} ${detail}`.trimEnd(), result.trimEnd()].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
