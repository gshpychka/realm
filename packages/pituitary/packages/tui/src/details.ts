import type { ToolView } from "@pituitary/session";
/** A task on the agent's todo list, as the `todo` tool reports it. */
export interface Task {
  id: string | number;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  activeForm?: string;
}

/** A question the model asked the operator, and what the operator answered. */
export interface Answer {
  question?: string;
  answer?: string;
}

/** What a tool attached to its call that pituitary draws in its own way. */
export type Details =
  | { kind: "diff"; diff: string }
  | { kind: "tasks"; tasks: Task[] }
  | {
      kind: "subagent";
      name: string;
      description?: string;
      status?: string;
      toolUses?: number;
      tokens?: number;
      durationMs?: number;
      activity?: string;
      error?: string;
    }
  | { kind: "search"; phase: string; curatorUrl?: string }
  | { kind: "answers"; answers: Answer[] }
  | { kind: "cancelled" }
  | { kind: "plan"; plan: string };

/** The fields of a value that arrived untyped, or none. */
type Fields = Readonly<Record<string, unknown>>;

const fieldsOf = (value: unknown): Fields =>
  value !== null && typeof value === "object" ? (value as Fields) : {};
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const list = (value: unknown): readonly unknown[] | undefined => (Array.isArray(value) ? value : undefined);

/** Each tool's details as pituitary draws them, by tool name; null where they hold none of it. */
const DECODERS = new Map<string, (fields: Fields) => Details | null>([
  [
    "edit",
    (fields) => {
      const diff = text(fields.diff);
      return diff === undefined ? null : { kind: "diff", diff };
    },
  ],
  [
    "todo",
    (fields) => {
      const tasks = list(fields.tasks);
      return tasks ? { kind: "tasks", tasks: tasks as Task[] } : null;
    },
  ],
  [
    "subagent",
    (fields) => {
      const name = text(fields.displayName);
      if (name === undefined) return null;
      return {
        kind: "subagent",
        name,
        description: text(fields.description),
        status: text(fields.status),
        toolUses: count(fields.toolUses),
        tokens: count(fields.tokens),
        durationMs: count(fields.durationMs),
        activity: text(fields.activity),
        error: text(fields.error),
      };
    },
  ],
  [
    "web_search",
    (fields) => {
      const phase = text(fields.phase);
      return phase === undefined ? null : { kind: "search", phase, curatorUrl: text(fields.curatorUrl) };
    },
  ],
  [
    "ask_user_question",
    (fields) => {
      const answers = list(fields.answers);
      if (!answers) return null;
      if (fields.cancelled) return { kind: "cancelled" };
      return {
        kind: "answers",
        answers: answers.map((each) => {
          const answer = fieldsOf(each);
          return { question: text(answer.question), answer: text(answer.answer) };
        }),
      };
    },
  ],
  [
    "plan_mode_complete",
    (fields) => {
      const plan = text(fields.plan);
      return plan === undefined ? null : { kind: "plan", plan };
    },
  ],
]);

/** What `tool` attached that pituitary draws in its own way, or null to show its output. */
export function detailsOf(tool: ToolView): Details | null {
  return DECODERS.get(tool.name)?.(fieldsOf(tool.details)) ?? null;
}

/** Where pi kept a call's whole output, when it cut what the model saw. */
export function fullOutputOf(tool: ToolView): string | null {
  return text(fieldsOf(tool.details).fullOutputPath) ?? null;
}
