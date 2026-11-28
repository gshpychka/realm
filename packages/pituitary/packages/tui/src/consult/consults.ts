import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Entry, restore } from "@pituitary/session";
import { PiConversation } from "../pi.ts";
import { OPINION_TYPE, type Opinion, type Position, readOpinion } from "../pi-bridge.ts";
import { type Item, transcriptOf } from "../transcript.ts";
import { type Asking, type ConsultLaunch, type ConsultModel, consultantArgs } from "./consult.ts";

/** Where one question put to one consultant stands. */
export type ConsultStatus =
  /** Its Pi is starting. */
  | "starting"
  /** It is answering. */
  | "answering"
  /** Its answer is going into the conversation's record. */
  | "recording"
  /**
   * Its answer is in the record. The conversation draws it as Pi hands it on, which waits for
   * the end of the turn a run is in.
   */
  | "recorded"
  /** It ended without an answer to record, for its `error`. */
  | "failed";

/** One question put to one consultant, as its card shows it from the asking until the conversation draws the answer. */
export interface LiveConsult {
  /** Unique among the frontend's consultations; the opinion it records carries it. */
  id: string;
  model: ConsultModel;
  /** What the question is about, as the card's row names it. */
  topic: string;
  status: ConsultStatus;
  /** Why it failed, in Pi's own words where it gave any. */
  error?: string;
  /** The consultant's own conversation, which its card draws as the main one is drawn. */
  link: PiConversation;
  /**
   * Which of the consultant's prompts the question is, counted from 1, once Pi has it: the
   * card draws what answers that prompt alone, and nothing before then.
   */
  round?: number;
  /** When it was asked, in milliseconds since the epoch. */
  at: number;
}

/** Whether `consult` is still at work: starting, answering, or recording its answer. */
export const working = (consult: LiveConsult) =>
  consult.status === "starting" || consult.status === "answering" || consult.status === "recording";

/**
 * Whether cancelling `consult` stops it: it is starting or answering. An answer going into the
 * record, or in it, joins the conversation all the same.
 */
export const stoppable = (consult: LiveConsult) =>
  consult.status === "starting" || consult.status === "answering";

/** Whether `consult` ended without an answer to record. */
export const failed = (consult: LiveConsult) => consult.status === "failed";

/** Lines of what a consultant's Pi wrote to stderr that say why it ended, the last it wrote. */
const STDERR_LINES = 4;
/** Characters of stderr kept for them. */
const STDERR_KEPT = 4096;
/** Extension questions nobody is there to answer for a consultant, which are cancelled as they open. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** What a consultant answered one question with, and what answering took. */
interface Answer {
  text: string;
  session?: string;
  cost: number;
  tokens: number;
  tools: number;
}

/** A run that settles: `done` settles with it and fails when Pi ends first; `off` stops waiting for it. */
interface Settling {
  done: Promise<void>;
  off(): void;
}

/** A consultant's Pi process, which runs while a card shows it. */
class Consultant {
  readonly link: PiConversation;
  /** Its session file, once Pi has said where. */
  session?: string;
  /** Why its Pi ended, once it has. */
  private ended?: string;
  private said = "";

  constructor(
    readonly model: ConsultModel,
    launch: ConsultLaunch,
    cwd: string,
    session?: string,
  ) {
    this.session = session;
    mkdirSync(launch.sessions, { recursive: true });
    this.link = new PiConversation({
      command: launch.command,
      args: consultantArgs(launch, model, session),
      cwd,
      log: launch.log,
      stderr: (text) => {
        launch.log?.(text);
        this.said = (this.said + text).slice(-STDERR_KEPT);
      },
    });
    this.link.onRequest((request) => {
      if (DIALOGS.has(request.method))
        this.link.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
    });
    this.link.onClose((reason) => {
      this.ended = reason;
    });
  }

  /**
   * Asks `prompt` and waits for the answer, saying through `asked` which round of the
   * session's prompts it is once Pi has it. Fails when Pi takes the prompt for an extension's
   * command, which starts no run.
   */
  async ask(prompt: string, asked: (round: number) => void): Promise<Answer> {
    const before = await this.link.getSessionStats();
    // The session's prompts are its user messages, each of which the reducer draws as a prompt.
    const round = (await this.link.getMessages()).filter(prompted).length + 1;
    // Waiting from before the prompt goes: the run can settle in the same read as Pi's answer to it.
    const settling = this.settling();
    try {
      const { disposition } = await this.link.rpc({ type: "prompt", message: prompt });
      if (disposition === "handled")
        throw new Error("Pi ran that as a command of its own, so nothing was asked.");
    } catch (error) {
      settling.off();
      throw error;
    }
    asked(round);
    await settling.done;
    const { sessionFile } = await this.link.getState();
    this.session = sessionFile;
    const view = restore(await this.link.getMessages());
    const after = await this.link.getSessionStats();
    return {
      text: answerOf(view.entries, round),
      ...(sessionFile ? { session: sessionFile } : {}),
      cost: after.cost - before.cost,
      tokens: after.tokens.total - before.tokens.total,
      tools: after.toolCalls - before.toolCalls,
    };
  }

  /** Why asking failed: `error`, and when Pi ended, the last it wrote to stderr, where Pi reports a model or sign-in it cannot use. */
  why(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (this.ended === undefined) return message;
    const tail = this.said
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-STDERR_LINES);
    return [message, ...tail].join("\n");
  }

  get alive(): boolean {
    return this.ended === undefined;
  }

  close(): Promise<void> {
    return this.link.close();
  }

  /** The run Pi starts next, settling. */
  private settling(): Settling {
    const offs: (() => void)[] = [];
    const off = () => {
      for (const each of offs.splice(0)) each();
    };
    const done = new Promise<void>((resolve, reject) => {
      const end = (finish: () => void) => {
        off();
        finish();
      };
      offs.push(this.link.onEvent((event) => event.type === "agent_settled" && end(resolve)));
      offs.push(this.link.onClose((reason) => end(() => reject(new Error(reason)))));
    });
    // It is waited on only once Pi takes the prompt; a Pi that ends before then fails the prompt instead.
    done.catch(() => {});
    return { done, off };
  }
}

const prompted = (message: unknown) =>
  typeof message === "object" && message !== null && "role" in message && message.role === "user";

/**
 * The entries that answer a consultant's prompt `round`: those after it, up to the prompt
 * after it. None before the round is known, or while the view has yet to hold its prompt.
 */
function answering(entries: readonly Entry[], round: number | undefined): readonly Entry[] {
  if (round === undefined) return [];
  const prompts = entries.flatMap((entry, index) => (entry.kind === "user" ? [index] : []));
  const start = prompts[round - 1];
  if (start === undefined) return [];
  return entries.slice(start + 1, prompts[round] ?? entries.length);
}

/** What a consultant's card draws of its `round`: the work and the reply that answer it. */
export function roundOf(entries: readonly Entry[], round: number | undefined, running: boolean): Item[] {
  return transcriptOf(answering(entries, round), running).filter(
    (item) => item.kind === "work" || item.kind === "reply",
  );
}

/** The reply that answers prompt `round`; throws why there is none, as the request's failure or an interruption. */
function answerOf(entries: readonly Entry[], round: number): string {
  const after = answering(entries, round);
  // A request that failed last ends the round with its error; one a retry made good does not.
  const last = after.findLast(
    (entry) => entry.kind === "assistant" || (entry.kind === "notice" && entry.level === "error"),
  );
  if (last?.kind === "notice") throw new Error(last.text);
  const reply = transcriptOf(after, false).findLast((item) => item.kind === "reply");
  if (reply?.kind !== "reply" || !reply.text.trim())
    throw new Error(reply?.note?.text ?? "it gave no answer");
  return reply.text;
}

export interface ConsultsOptions {
  launch: ConsultLaunch;
  /** The conversation the opinions are about, and recorded in. */
  main: PiConversation;
}

/**
 * The second opinions the operator asked for, each from a consultant of its own, whose Pi runs
 * while its card shows: a session replaced under the conversation leaves it answering, and a
 * reply to its opinion starts it again on its session.
 */
export class Consults {
  /** The models chosen last, which the next list starts with where none are declared. */
  chosen: readonly string[] = [];
  private live: readonly LiveConsult[] = [];
  private readonly consultants = new Set<Consultant>();
  private readonly listeners = new Set<() => void>();
  private readonly offs: (() => void)[];

  constructor(private readonly options: ConsultsOptions) {
    this.offs = [
      options.main.onEvent((event) => {
        if (event.type !== "message_start") return;
        const message = event.message as { role?: string; customType?: string; details?: unknown };
        // The operator's next prompt moves on from the cards that failed, which go with it.
        if (message.role === "user") {
          if (this.live.some(failed)) this.set(this.live.filter((consult) => !failed(consult)));
          return;
        }
        // A card goes as the conversation draws its opinion, in the same frame.
        const id =
          message.role === "custom" &&
          message.customType === OPINION_TYPE &&
          readOpinion(message.details)?.id;
        if (id) this.set(this.live.filter((consult) => consult.id !== id));
      }),
      // An opinion goes into the session Pi had open as it was recorded; a session replaced before
      // the conversation drew it takes the card with it.
      options.main.onReplace(() => this.set(this.live.filter((consult) => consult.status !== "recorded"))),
    ];
  }

  /** Follows `snapshot`, for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** The consultations a card shows; a new array whenever one changes. */
  readonly snapshot = (): readonly LiveConsult[] => this.live;

  /**
   * Asks each of `models` `prompt` in Pi working in `cwd`, which its card names by `asking`'s
   * topic, about the conversation as it stood `about`.
   */
  start(models: readonly ConsultModel[], asking: Asking, prompt: string, about: Position, cwd: string): void {
    for (const model of models)
      this.ask(new Consultant(model, this.options.launch, cwd), asking, prompt, about);
  }

  /**
   * Asks the consultant that gave `opinion` `asking`, in its Pi where a card still shows it, or
   * in a new one on its session. False while it is still answering.
   */
  followUp(opinion: Opinion & { session: string }, asking: Asking, about: Position, cwd: string): boolean {
    const shown = [...this.consultants].find((each) => each.alive && each.session === opinion.session);
    if (shown && this.live.some((consult) => consult.link === shown.link && working(consult))) return false;
    const consultant =
      shown ??
      new Consultant(
        { provider: opinion.provider, id: opinion.model, ...(opinion.name ? { name: opinion.name } : {}) },
        this.options.launch,
        cwd,
        opinion.session,
      );
    this.ask(consultant, asking, asking.question, about);
    return true;
  }

  /** Takes the card `id` away, which stops its consultant if it is at work; the card it was. */
  cancel(id: string): LiveConsult | undefined {
    const consult = this.live.find((each) => each.id === id);
    if (consult) this.set(this.live.filter((each) => each !== consult));
    return consult;
  }

  /**
   * Stops every consultant starting or answering, and takes away the cards that failed; how
   * many of each. An answer already recorded joins the conversation all the same, so its card stays.
   */
  cancelAll(): { stopped: number; cleared: number } {
    const stopped = this.live.filter(stoppable).length;
    const cleared = this.live.filter(failed).length;
    this.set(this.live.filter((consult) => !stoppable(consult) && !failed(consult)));
    return { stopped, cleared };
  }

  /** What the card `consult` says, as text: the reply so far to its question, and why it failed when it did. */
  async textOf(consult: LiveConsult): Promise<string> {
    // A consultant whose Pi has ended has only its error to give.
    const reply = await consult.link.getSnapshot().then(
      (snapshot) => {
        const { entries } = restore(snapshot.messages, undefined, snapshot);
        const said = roundOf(entries, consult.round, false).findLast((item) => item.kind === "reply");
        return said?.kind === "reply" ? said.text : "";
      },
      () => "",
    );
    return [reply, consult.error ?? ""].filter(Boolean).join("\n\n");
  }

  /** Ends every consultant, as the frontend closes. */
  dispose(): void {
    for (const off of this.offs) off();
    this.listeners.clear();
    for (const consultant of this.consultants) void consultant.close();
    this.consultants.clear();
  }

  private ask(consultant: Consultant, asking: Asking, prompt: string, about: Position): void {
    const id = randomUUID();
    const { model, link } = consultant;
    this.consultants.add(consultant);
    this.set([...this.live, { id, model, topic: asking.topic, status: "starting", link, at: Date.now() }]);
    const update = (patch: Partial<LiveConsult>) =>
      this.set(this.live.map((consult) => (consult.id === id ? { ...consult, ...patch } : consult)));
    const listed = () => this.live.some((consult) => consult.id === id);
    void consultant
      .ask(prompt, (round) => update({ status: "answering", round }))
      .then(async (answer) => {
        if (!listed()) return;
        update({ status: "recording" });
        const opinion: Opinion = {
          id,
          provider: model.provider,
          model: model.id,
          ...(model.name ? { name: model.name } : {}),
          question: asking.question,
          topic: asking.topic,
          answer: answer.text,
          ...(answer.session ? { session: answer.session } : {}),
          cost: answer.cost,
          tokens: answer.tokens,
          tools: answer.tools,
        };
        // Pi refuses it once the conversation is no longer the one it is about.
        await this.options.main.bridge({ kind: "record-opinion", opinion, about });
        update({ status: "recorded" });
      })
      .catch((error: unknown) => {
        // A cancelled consultation has nothing left to say; a failed one's card stays until the operator moves on.
        if (listed()) update({ status: "failed", error: consultant.why(error) });
      });
  }

  private set(live: readonly LiveConsult[]): void {
    this.live = live;
    // A consultant's Pi runs while a card shows it; a reply to its opinion starts another on its session.
    for (const consultant of this.consultants) {
      if (live.some((consult) => consult.link === consultant.link)) continue;
      this.consultants.delete(consultant);
      void consultant.close();
    }
    for (const listener of this.listeners) listener();
  }
}
