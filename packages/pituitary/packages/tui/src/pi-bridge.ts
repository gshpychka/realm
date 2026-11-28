/**
 * Pituitary's own channel into Pi, for what Pi's RPC lacks: listing and managing saved
 * sessions, moving through the session's tree, reloading resources, and a second opinion's
 * context and record. The frontend sends a
 * request as the arguments of the bridge extension's command, and the extension answers
 * through a status that the frontend takes out of the stream before any extension UI sees
 * it. Both sides share this module, so it imports nothing.
 */

/**
 * The command the bridge extension registers. Pi renames commands that share a name
 * (`pituitary:1`, `pituitary:2`), and an unknown `/name` reaches the model as a prompt, so the
 * frontend finds the command by its extension's file instead of assuming this name.
 */
export const BRIDGE_COMMAND = "pituitary";
/** The status key the bridge answers through. It never reaches the extension UI. */
export const BRIDGE_STATUS = "pituitary.bridge";
/**
 * The status key that marks a Pi runtime: set to its `RuntimeMark` when the runtime starts,
 * cleared when it ends. Pi replaces its runtime for new, forked, resumed and reloaded sessions.
 */
export const RUNTIME_STATUS = "pituitary.runtime";

/** A saved session, as the resume picker shows it. */
export interface SessionSummary {
  path: string;
  id: string;
  /** Where the session was started; empty for sessions saved before Pi recorded it. */
  cwd: string;
  name?: string;
  /** The session this one was forked from. */
  parent?: string;
  /** When the session last changed, in milliseconds since the epoch. */
  modified: number;
  /** The prompts the operator sent in it, on every branch. */
  prompts: number;
  /** The session's first prompt. */
  first: string;
}

/** What an entry of the session tree holds, as far as the tree picker tells entries apart. */
export const TREE_KINDS = [
  "user",
  "assistant",
  "tool",
  "bash",
  "custom",
  "compaction",
  "branch",
  "other",
] as const;
export type TreeKind = (typeof TREE_KINDS)[number];

/** One entry of the session tree, with only what the tree picker draws. */
export interface TreeNode {
  id: string;
  /** The entry it follows; null for the session's first. */
  parent: string | null;
  kind: TreeKind;
  /**
   * The start of what it says: a prompt, as the operator would type it again, a reply, a
   * command, an extension's message or a summary. Empty for what the picker leaves out, such as
   * a tool's result.
   */
  text: string;
  /** The skills a prompt loaded, by name; absent when it loaded none. */
  skills?: string[];
  /** The operator's label on it. */
  label?: string;
  /** A compaction's context tokens before it. */
  tokens?: number;
  /** When Pi recorded it, in milliseconds since the epoch. */
  at: number;
}

/**
 * The custom message type a second opinion is recorded as. Pi sends a custom message to the
 * model as the operator's, so the agent reads the opinion as context from then on.
 */
export const OPINION_TYPE = "pituitary.opinion";

/** A second opinion another model gave on the conversation, as its custom message's details hold it. */
export interface Opinion {
  /** Which consultation it answers, unique among them. */
  id: string;
  provider: string;
  /** The model's id at its provider. */
  model: string;
  /** What Pi's registry names the model, when it names it. */
  name?: string;
  question: string;
  answer: string;
  /** The consultant's own session file, which a reply to it continues. */
  session?: string;
  /** What answering cost, in dollars, the tokens it took, and the tool calls it made to check the code. */
  cost: number;
  tokens: number;
  tools: number;
}

/** The model an opinion came from, as the operator reads it: its name, or `provider/id`. */
export const opinionModel = (opinion: Pick<Opinion, "provider" | "model" | "name">): string =>
  opinion.name?.trim() || `${opinion.provider}/${opinion.model}`;

/** What the model reads of a recorded opinion. */
export function opinionText(opinion: Opinion): string {
  return `Second opinion from ${opinionModel(opinion)}, requested by the operator.\nQuestion: ${opinion.question}\n\n${opinion.answer}`;
}

/** The opinion a custom message's details hold; undefined when they hold none. */
export function readOpinion(details: unknown): Opinion | undefined {
  if (!isFields(details)) return undefined;
  const { id, provider, model, name, question, answer, session, cost, tokens, tools } = details;
  if (
    !text(id) ||
    !text(provider) ||
    !text(model) ||
    typeof question !== "string" ||
    typeof answer !== "string" ||
    typeof cost !== "number" ||
    typeof tokens !== "number" ||
    typeof tools !== "number" ||
    (name !== undefined && typeof name !== "string") ||
    (session !== undefined && typeof session !== "string")
  )
    return undefined;
  return {
    id,
    provider,
    model,
    ...(name ? { name } : {}),
    question,
    answer,
    ...(session ? { session } : {}),
    cost,
    tokens,
    tools,
  };
}

/** What each kind of request carries, and what its reply holds. */
export interface BridgeKinds {
  /** This project's saved sessions, or every project's. */
  sessions: { request: { all: boolean }; result: { sessions: SessionSummary[] } };
  "rename-session": { request: { path: string; name: string }; result: null };
  /** Refused for the session Pi has open; `trashed` when a `trash` command took the file rather than deleting it for good. */
  "delete-session": { request: { path: string }; result: { trashed: boolean } };
  /** Reloads extensions, skills, prompts, themes and context files. */
  reload: { request: Record<never, never>; result: null };
  /**
   * The session's entries on every branch, where it stands among them, and whether Pi's
   * settings skip asking to summarize the branch a move leaves (`branchSummary.skipPrompt`).
   */
  tree: {
    request: Record<never, never>;
    result: { nodes: TreeNode[]; leaf: string | null; skipSummaryPrompt: boolean };
  };
  /**
   * Moves the session to the entry `entryId`, summarizing the branch it leaves when asked, with
   * `instructions` for the summary. Pi leaves a prompt, or an extension's message, to be written
   * again: the session moves to just before it, and `text` holds it. `cancelled` when an
   * extension, or an abort, kept the session where it was.
   */
  navigate: {
    request: { entryId: string; summarize: boolean; instructions?: string };
    result: { cancelled: boolean; text: string };
  };
  /** Labels an entry of the session; an empty label takes the label off. */
  label: { request: { entryId: string; label: string }; result: null };
  /**
   * The branch the session is on as text another model can read, as Pi serializes a
   * conversation for a summary: its latest turns, as many as `budget` characters hold, and how
   * many earlier ones that left out. Empty when the branch holds no conversation yet.
   */
  "consult-context": { request: { budget: number }; result: { digest: string; omitted: number } };
  /**
   * Records a second opinion as a custom message the conversation shows, which the model
   * reads from its next request on. While a run goes on, Pi adds it as the run's turn ends.
   */
  "record-opinion": { request: { opinion: Opinion }; result: null };
}
export type BridgeKind = keyof BridgeKinds;
export type BridgeRequest<K extends BridgeKind = BridgeKind> = K extends BridgeKind
  ? { kind: K } & BridgeKinds[K]["request"]
  : never;
export type BridgeResult<K extends BridgeKind> = BridgeKinds[K]["result"];
/** A request as sent, with the id its reply carries. */
export type BridgeCall = BridgeRequest & { id: string };
export type BridgeReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };
/** What a runtime's start reports. */
export interface RuntimeMark {
  cwd: string;
  /**
   * What each of the runtime's prompt templates takes, by name, as its `argument-hint`
   * frontmatter declares it, such as `<focus>`; Pi's RPC command list leaves the hint out.
   */
  argumentHints: Record<string, string>;
}

/** A request that cannot be read; `id` is present when the reply can still name its request. */
export class BridgeError extends Error {
  constructor(
    message: string,
    readonly id?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const encodeCall = (call: BridgeCall): string => JSON.stringify(call);
export const encodeReply = (reply: BridgeReply): string => JSON.stringify(reply);
export const encodeRuntime = (mark: RuntimeMark): string => JSON.stringify(mark);

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** The request `args` hold, validated by kind; throws a `BridgeError` for anything else. */
export function decodeCall(args: string): BridgeCall {
  const value = parse(args.trim());
  if (!isFields(value)) throw new BridgeError("The bridge request is not a JSON object.");
  const id = text(value.id) ? value.id : undefined;
  if (!id) throw new BridgeError("The bridge request has no id.");
  const fail = (message: string): never => {
    throw new BridgeError(message, id);
  };
  switch (value.kind) {
    case "sessions":
      if (typeof value.all !== "boolean") fail("sessions needs `all`.");
      return { id, kind: "sessions", all: value.all as boolean };
    case "rename-session": {
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (!text(value.path) || !name) fail("rename-session needs a path and a name.");
      return { id, kind: "rename-session", path: value.path as string, name };
    }
    case "delete-session":
      if (!text(value.path)) fail("delete-session needs a path.");
      return { id, kind: "delete-session", path: value.path as string };
    case "reload":
      return { id, kind: "reload" };
    case "tree":
      return { id, kind: "tree" };
    case "navigate": {
      if (!text(value.entryId) || typeof value.summarize !== "boolean")
        fail("navigate needs an entryId and whether to summarize.");
      const instructions = typeof value.instructions === "string" ? value.instructions.trim() : "";
      return {
        id,
        kind: "navigate",
        entryId: value.entryId as string,
        summarize: value.summarize as boolean,
        ...(instructions ? { instructions } : {}),
      };
    }
    case "label":
      if (!text(value.entryId) || typeof value.label !== "string")
        fail("label needs an entryId and a label.");
      return { id, kind: "label", entryId: value.entryId as string, label: (value.label as string).trim() };
    case "consult-context":
      if (typeof value.budget !== "number" || !(value.budget > 0))
        fail("consult-context needs a budget of characters.");
      return { id, kind: "consult-context", budget: Math.floor(value.budget as number) };
    case "record-opinion": {
      const opinion = readOpinion(value.opinion);
      if (!opinion) fail("record-opinion needs an opinion.");
      return { id, kind: "record-opinion", opinion: opinion as Opinion };
    }
    default:
      return fail(`Unknown bridge request: ${String(value.kind)}`);
  }
}

/** The reply a bridge status carries; undefined when it is not one. */
export function decodeReply(status: string | undefined): BridgeReply | undefined {
  const value = status === undefined ? undefined : parse(status);
  if (!isFields(value) || !text(value.id)) return;
  if (value.ok === true) return { id: value.id, ok: true, result: value.result ?? null };
  if (value.ok === false) return { id: value.id, ok: false, error: String(value.error ?? "failed") };
}

/** The runtime mark a status carries, keeping only hints that are text; undefined when it is not one. */
export function decodeRuntime(status: string | undefined): RuntimeMark | undefined {
  const value = status === undefined ? undefined : parse(status);
  if (!isFields(value) || !text(value.cwd)) return undefined;
  const hints = isFields(value.argumentHints) ? Object.entries(value.argumentHints) : [];
  return {
    cwd: value.cwd,
    argumentHints: Object.fromEntries(hints.filter((hint): hint is [string, string] => text(hint[1]))),
  };
}

/** The reply's result in the shape `kind` answers with, dropping anything that is not. */
export function readResult<K extends BridgeKind>(kind: K, result: unknown): BridgeResult<K> {
  switch (kind) {
    case "sessions": {
      const sessions = isFields(result) && Array.isArray(result.sessions) ? result.sessions : [];
      return { sessions: sessions.filter(isSummary) } as BridgeResult<K>;
    }
    case "delete-session":
      return { trashed: isFields(result) && result.trashed === true } as BridgeResult<K>;
    case "tree": {
      const fields = isFields(result) ? result : {};
      return {
        nodes: Array.isArray(fields.nodes) ? fields.nodes.filter(isTreeNode) : [],
        leaf: text(fields.leaf) ? fields.leaf : null,
        skipSummaryPrompt: fields.skipSummaryPrompt === true,
      } as BridgeResult<K>;
    }
    case "consult-context": {
      const fields = isFields(result) ? result : {};
      return {
        digest: typeof fields.digest === "string" ? fields.digest : "",
        omitted: typeof fields.omitted === "number" ? fields.omitted : 0,
      } as BridgeResult<K>;
    }
    case "navigate": {
      // A reply that cannot say the session stayed is read as a move, which the view then reads afresh.
      const fields = isFields(result) ? result : {};
      return {
        cancelled: fields.cancelled === true,
        text: typeof fields.text === "string" ? fields.text : "",
      } as BridgeResult<K>;
    }
    default:
      return null as BridgeResult<K>;
  }
}

function isTreeNode(value: unknown): value is TreeNode {
  return (
    isFields(value) &&
    text(value.id) &&
    (value.parent === null || text(value.parent)) &&
    TREE_KINDS.includes(value.kind as TreeKind) &&
    typeof value.text === "string" &&
    typeof value.at === "number" &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.skills === undefined || (Array.isArray(value.skills) && value.skills.every(text))) &&
    (value.tokens === undefined || typeof value.tokens === "number")
  );
}

function isSummary(value: unknown): value is SessionSummary {
  return (
    isFields(value) &&
    text(value.path) &&
    text(value.id) &&
    typeof value.cwd === "string" &&
    typeof value.modified === "number" &&
    typeof value.prompts === "number" &&
    typeof value.first === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.parent === undefined || typeof value.parent === "string")
  );
}
