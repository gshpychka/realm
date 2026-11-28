import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Entry, restore } from "@pituitary/session";
import { PiConversation } from "../pi.ts";
import { OPINION_TYPE, type Opinion, readOpinion } from "../pi-bridge.ts";
import { type Item, transcriptOf } from "../transcript.ts";
import { type ConsultLaunch, type ConsultModel, consultantArgs } from "./consult.ts";

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
  question: string;
  status: ConsultStatus;
  /** Why it failed, in Pi's own words where it gave any. */
  error?: string;
  /** The consultant's own conversation, which its card draws as the main one is drawn. */
  link: PiConversation;
  /** The prompts the consultant's session holds once this question is asked, 0 until then: the card draws what follows the last. */
  round: number;
  /** When it was asked, in milliseconds since the epoch. */
  at: number;
}

/** Whether `consult` is still at work: starting, answering, or recording its answer. */
export const working = (consult: LiveConsult) =>
  consult.status === "starting" || consult.status === "answering" || consult.status === "recording";

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

/** A consultant's Pi process, which is kept for the operator's replies to it until the frontend closes. */
class Consultant {
  readonly link: PiConversation;
  /** Its session file, once Pi has said where. */
  session?: string;
  /** Whether it recorded an opinion, which a reply could continue. */
  recorded = false;
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
   * session's prompts it is once Pi has it.
   */
  async ask(prompt: string, asked: (round: number) => void): Promise<Answer> {
    const before = await this.link.getSessionStats();
    const round = (await this.link.getMessages()).filter(prompted).length + 1;
    const settled = this.settled();
    await this.link.prompt(prompt);
    asked(round);
    await settled;
    const { sessionFile } = await this.link.getState();
    this.session = sessionFile;
    const view = restore(await this.link.getMessages());
    const after = await this.link.getSessionStats();
    return {
      text: answerOf(view.entries),
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

  /** Settles once the run Pi starts next settles; fails when Pi ends first. */
  private settled(): Promise<void> {
    return new Promise((resolve, reject) => {
      const offs: (() => void)[] = [];
      const end = (finish: () => void) => {
        for (const off of offs) off();
        finish();
      };
      offs.push(this.link.onEvent((event) => event.type === "agent_settled" && end(resolve)));
      offs.push(this.link.onClose((reason) => end(() => reject(new Error(reason)))));
    });
  }
}

const prompted = (message: unknown) =>
  typeof message === "object" && message !== null && "role" in message && message.role === "user";

/**
 * The entries after a consultant's latest prompt, which answer it; none while the view holds
 * fewer than `round` prompts, before the round's own prompt reaches it.
 */
function answering(entries: readonly Entry[], round: number): readonly Entry[] {
  if (entries.filter((entry) => entry.kind === "user").length < round) return [];
  return entries.slice(entries.findLastIndex((entry) => entry.kind === "user") + 1);
}

/** What a consultant's card draws of its `round`: the work and the reply that answer it. */
export function roundOf(entries: readonly Entry[], round: number, running: boolean): Item[] {
  return transcriptOf(answering(entries, round), running).filter(
    (item) => item.kind === "work" || item.kind === "reply",
  );
}

/** The reply that answers the latest prompt; throws why there is none, as the request's failure or an interruption. */
function answerOf(entries: readonly Entry[]): string {
  const after = answering(entries, 0);
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
 * The second opinions the operator asked for, each from a consultant of its own. They last as
 * long as the frontend: a session replaced under the conversation leaves them answering, and a
 * consultant that answered stays for the operator's reply to it.
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
      // A card goes as the conversation draws its opinion, in the same frame.
      options.main.onEvent((event) => {
        if (event.type !== "message_start") return;
        const message = event.message as { role?: string; customType?: string; details?: unknown };
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
   * Asks each of `models` `prompt` in Pi working in `cwd`, which its card shows as `question`,
   * about the session whose file is `about`.
   */
  start(models: readonly ConsultModel[], question: string, prompt: string, about: string, cwd: string): void {
    for (const model of models) {
      const consultant = new Consultant(model, this.options.launch, cwd);
      this.consultants.add(consultant);
      this.ask(consultant, question, prompt, about);
    }
  }

  /**
   * Asks the consultant that gave `opinion` `question`, in its Pi where that still runs, or in
   * a new one on its session. False while it is still answering.
   */
  followUp(opinion: Opinion & { session: string }, question: string, about: string, cwd: string): boolean {
    const running = [...this.consultants].find((each) => each.alive && each.session === opinion.session);
    if (running && this.live.some((consult) => consult.link === running.link && working(consult)))
      return false;
    const consultant =
      running ??
      new Consultant(
        { provider: opinion.provider, id: opinion.model, ...(opinion.name ? { name: opinion.name } : {}) },
        this.options.launch,
        cwd,
        opinion.session,
      );
    consultant.recorded = true;
    this.consultants.add(consultant);
    this.ask(consultant, question, question, about);
    return true;
  }

  /**
   * Takes the card `id` away. A consultant still at work stops, and answers a reply later in a
   * new Pi on its session; one that never recorded an opinion has nothing a reply could continue.
   */
  cancel(id: string): void {
    const consult = this.live.find((each) => each.id === id);
    if (!consult) return;
    this.set(this.live.filter((each) => each !== consult));
    const consultant = [...this.consultants].find((each) => each.link === consult.link);
    if (!consultant || (!working(consult) && consultant.recorded)) return;
    this.consultants.delete(consultant);
    void consultant.close();
  }

  /** Takes every card away, stopping the consultants at work; how many there were. */
  cancelAll(): number {
    const cards = this.live.length;
    for (const consult of this.live) this.cancel(consult.id);
    return cards;
  }

  /** Ends every consultant, as the frontend closes. */
  dispose(): void {
    for (const off of this.offs) off();
    this.listeners.clear();
    for (const consultant of this.consultants) void consultant.close();
    this.consultants.clear();
  }

  private ask(consultant: Consultant, question: string, prompt: string, about: string): void {
    const id = randomUUID();
    const { model, link } = consultant;
    this.set([...this.live, { id, model, question, status: "starting", link, round: 0, at: Date.now() }]);
    const update = (patch: Partial<LiveConsult>) =>
      this.set(this.live.map((consult) => (consult.id === id ? { ...consult, ...patch } : consult)));
    const listed = () => this.live.some((consult) => consult.id === id);
    void consultant
      .ask(prompt, (round) => update({ status: "answering", round }))
      .then(async (answer) => {
        if (!listed()) return;
        update({ status: "recording" });
        const { main } = this.options;
        if ((await main.getState()).sessionFile !== about)
          throw new Error("Not recorded: Pi has moved to another session since you asked.");
        const opinion: Opinion = {
          id,
          provider: model.provider,
          model: model.id,
          ...(model.name ? { name: model.name } : {}),
          question,
          answer: answer.text,
          ...(answer.session ? { session: answer.session } : {}),
          cost: answer.cost,
          tokens: answer.tokens,
          tools: answer.tools,
        };
        await main.bridge({ kind: "record-opinion", opinion });
        consultant.recorded = true;
        update({ status: "recorded" });
      })
      .catch((error: unknown) => {
        // A cancelled consultation has nothing left to say; a failed one's card stays until dismissed.
        if (listed()) update({ status: "failed", error: consultant.why(error) });
      });
  }

  private set(live: readonly LiveConsult[]): void {
    this.live = live;
    for (const listener of this.listeners) listener();
  }
}
