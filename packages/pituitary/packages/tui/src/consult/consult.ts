import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CustomEntry } from "@pituitary/session";
import type { PiCommand, PiFlag } from "../cli.ts";
import { modelName } from "../model-names.ts";
import { OPINION_TYPE, type Opinion, opinionModel, readOpinion } from "../pi-bridge.ts";
import { counted } from "../plural.ts";

/**
 * The operator's flags a consultant's Pi takes too, by name, each with whether a value follows
 * it: the extensions and skills they load or turn off, offline mode, context files, and project
 * trust. Flags that choose a session, a model, the tools or the system prompt stay the main
 * conversation's, and Pituitary's own extensions are never among the operator's flags.
 */
const FORWARDED = {
  "--extension": true,
  "-e": true,
  "--no-extensions": false,
  "-ne": false,
  "--skill": true,
  "--no-skills": false,
  "-ns": false,
  "--no-context-files": false,
  "-nc": false,
  "--offline": false,
  "--approve": false,
  "-a": false,
  "--no-approve": false,
  "-na": false,
} as const satisfies Record<string, boolean>;

type Forwarded = keyof typeof FORWARDED;
const forwarded = (name: string): name is Forwarded => Object.hasOwn(FORWARDED, name);

/**
 * The operator's flags a consultant takes, a flag's value inline, `--skill=path`, or after it. A
 * relative path is resolved from `cwd`, where Pi started: a consultant works where the session
 * does, which a session resumed from another project moves. A source that names a scheme, such
 * as `builtin:mcp`, stays as it is.
 */
export function forwardedFlags(flags: readonly PiFlag[], cwd: string): string[] {
  const located = (path: string) =>
    isAbsolute(path) || /^[a-z][\w+.-]*:/i.test(path) ? path : resolve(cwd, path);
  return flags.flatMap(({ flag, value }) => {
    const [name = "", inline] = flag.split(/=(.*)/s, 2);
    if (!forwarded(name)) return [];
    if (!FORWARDED[name]) return [flag];
    if (inline !== undefined) return [`${name}=${located(inline)}`];
    return value === undefined ? [] : [flag, located(value)];
  });
}

/** How a consultant's Pi starts: the operator's own Pi command, with the flags of theirs it takes. */
export interface ConsultLaunch {
  command: string;
  args: readonly string[];
  /** The models the operator declared to consult unless they choose others, as `provider/id`. */
  declared: readonly string[];
  /** Where consultants keep their sessions: apart from Pi's own, so `--continue` and the resume list pass them by. */
  sessions: string;
  /** Receives what the consultants' Pi processes write to stderr. */
  log?(text: string): void;
}

/**
 * A consultant's Pi for the operator's `agent`, started in `cwd`, from `PITUITARY_CONSULT_MODELS`,
 * its declared models, comma separated, and the state directory, `$XDG_STATE_HOME` or
 * `~/.local/state`.
 */
export function consultLaunch(
  agent: PiCommand,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ConsultLaunch {
  return {
    command: agent.command,
    args: [...agent.prefix, ...forwardedFlags(agent.flags, cwd)],
    declared: (environment.PITUITARY_CONSULT_MODELS ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
    sessions: join(environment.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pituitary", "consults"),
  };
}

/** A model a consultant runs, as Pi's registry describes it; a declared model Pi does not list has only its address. */
export interface ConsultModel {
  provider: string;
  id: string;
  name?: string;
  /** The tokens its context holds, when Pi knows them. */
  contextWindow?: number;
}

/** A model given as `provider/id`; null when it names no provider. */
export function modelAt(address: string): ConsultModel | null {
  const slash = address.indexOf("/");
  if (slash <= 0 || slash === address.length - 1) return null;
  return { provider: address.slice(0, slash), id: address.slice(slash + 1) };
}

/** The tools a consultant checks the conversation's claims with: it reads, and changes nothing. */
const READ_ONLY_TOOLS = "read,grep,find,ls";

/** The consultant's part, which Pi's system prompt ends with. */
const REVIEWER_ROLE =
  "You are an independent reviewer the operator consulted for a second opinion on another coding agent's work. Never modify files. Verify claims against the code before you rely on them. Be concise and direct.";

/**
 * A consultant's Pi arguments after `launch`'s: its model, read-only tools without MCP, its
 * part, and a session among the consultants', named for its model, or `session` when it
 * continues one.
 */
export function consultantArgs(launch: ConsultLaunch, model: ConsultModel, session?: string): string[] {
  return [
    ...launch.args,
    "--session-dir",
    launch.sessions,
    ...(session ? ["--session", session] : ["--name", `second opinion · ${modelName(model)}`]),
    // With its provider named, Pi reads the id whole, though ids hold slashes.
    "--provider",
    model.provider,
    "--model",
    model.id,
    "--tools",
    READ_ONLY_TOOLS,
    "--no-mcp",
    "--append-system-prompt",
    REVIEWER_ROLE,
  ];
}

/** What a consultant is asked, and what the rows that show the question name it by. */
export interface Asking {
  /** What the consultant reads. */
  question: string;
  /** What the question is about, on one row. */
  topic: string;
}

/** What a consultant is asked when the operator asks nothing in particular. */
export const REVIEW: Asking = {
  question:
    "Review the conversation so far: is the approach sound, what mistakes do you see, what are the risks, and what would you do differently?",
  topic: "review of the conversation so far",
};

/** The operator's own question, named by its first line. */
export const asking = (question: string): Asking => ({
  question,
  topic: question.split("\n")[0]?.trim() ?? "",
});

/**
 * A consultant's first prompt: the conversation the operator had with `agent`, the model,
 * framed as a record to judge rather than one to continue, then `question`, and the shape of
 * the answer.
 */
export function firstPrompt({
  digest,
  omitted,
  question,
  agent,
}: {
  digest: string;
  /** Earlier turns the digest leaves out. */
  omitted: number;
  question: string;
  agent: string;
}): string {
  return [
    `The operator asks for your second opinion on their conversation with ${agent}, a coding agent working in this project. Read the conversation, check what it claims against the code where that matters, and answer the operator's question.`,
    "",
    "<conversation>",
    ...(omitted > 0 ? [`[${counted(omitted, "earlier turn")} left out]`, ""] : []),
    // The conversation cannot end its own frame early.
    digest.replaceAll("</conversation>", "<\\/conversation>"),
    "</conversation>",
    "",
    `The operator's question: ${question}`,
    "",
    "Answer with a one-line verdict first, then the key points (where you agree, where you disagree, and the risks you see), then concrete recommendations.",
  ].join("\n");
}

/** Characters a token takes, roughly, in English and code. */
const CHARS_PER_TOKEN = 4;
/** The window assumed for a model whose context Pi does not describe. */
const UNKNOWN_WINDOW = 128_000;

/**
 * The characters the conversation may take in a consultation of `models`: half the smallest
 * context window among them, leaving the rest to Pi's system prompt and tools, the files the
 * consultant reads, and its answer.
 */
export function digestBudget(models: readonly ConsultModel[]): number {
  const windows = models.map((model) => model.contextWindow ?? UNKNOWN_WINDOW);
  const window = windows.length > 0 ? Math.min(...windows) : UNKNOWN_WINDOW;
  return Math.floor(window / 2) * CHARS_PER_TOKEN;
}

/** Lines of a reply its question quotes, which find it in the conversation. */
const QUOTED = 3;

/**
 * What a consultant is asked of one of `agent`'s replies, quoting its first lines, which find it
 * in the conversation; named by the first of them, which tells one reply from another.
 */
export function replyQuestion(reply: string, agent: string): Asking {
  const lines = reply
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, QUOTED);
  return {
    question: [
      `Weigh in on this reply from ${agent}: is it right, and what would you do differently?`,
      ...lines.map((line) => `> ${line}`),
    ].join("\n"),
    topic: `on “${lines[0]?.trim() ?? ""}”`,
  };
}

/** What asks the agent to weigh `opinion`, which it has just read, named by its model and its topic. */
export function addressPrompt(opinion: Opinion): string {
  return `Address the second opinion from ${opinionModel(opinion)} above (${opinion.topic}): say where you agree or disagree and why, then act on what holds up.`;
}

/** A conversation's custom entry that records a second opinion. */
export type OpinionEntry = CustomEntry & { details: Opinion };

/** Whether `entry` records a second opinion. */
export const isOpinion = (entry: CustomEntry): entry is OpinionEntry =>
  entry.customType === OPINION_TYPE && readOpinion(entry.details) !== undefined;
