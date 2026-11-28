import { plain } from "@pituitary/session";
import type { DialogResponse } from "./components/dialog.tsx";
import { glyphs } from "./glyphs.ts";
import type { PiUiPort, PiUiRequest } from "./pi.ts";
import { RUNTIME_STATUS } from "./pi-bridge.ts";
import { FAST_STATUS } from "./pi-fast.ts";
import { decodeUsage } from "./usage/presentation.ts";
import { USAGE_STATUS, type UsageDisplay } from "./usage/types.ts";

export type PiQuestion = Extract<PiUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type PiWidget = { lines: string[]; placement: "aboveEditor" | "belowEditor" };

/** What Pi's extensions show around the conversation, as the frontend draws it. */
export interface PiUiState {
  /** Open questions, the first to answer first, with when each stops waiting. */
  questions: readonly { request: PiQuestion; deadline?: number }[];
  statuses: Readonly<Record<string, string>>;
  widgets: Readonly<Record<string, PiWidget>>;
  /** Whether replies to the selected model come at Fast mode's priority speed. */
  fast: boolean;
  usage?: UsageDisplay;
}

/** What an extension asks of the frontend once, rather than as state it keeps showing. */
export type PiUiEffect =
  | { kind: "notify"; level: "info" | "warning" | "error"; text: string }
  | { kind: "title"; title: string }
  | { kind: "draft"; text: string };

const EMPTY: PiUiState = { questions: [], statuses: {}, widgets: {}, fast: false };

/** Extension counters that belong in their own commands' views, such as /automode status and /rewind. */
const UNSHOWN = new Set(["pi-automode", "rewind"]);

function extensionStatus(key: string, text = ""): string {
  const status = plain(text);
  if (key !== "pi-lens-lsp") return status;
  return status.replace(/LSP Active: (.*?)(?= · |$)/, (_match, servers: string) =>
    servers
      .split(",")
      .map((server) => (server.trim() === "typescript" ? glyphs.typescript : glyphs.lsp))
      .join(" "),
  );
}

/**
 * Pi's extension UI for one connection. It listens from its creation, so what the extensions
 * show outlives the views drawing it, and a new session's statuses, which Pi sends before it
 * answers the request that made the session, are kept. When a Pi runtime ends, as Pi's own
 * screen does, everything its extensions showed goes and their open questions are cancelled.
 */
export class PiUiStore {
  private state = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly effectListeners = new Set<(effect: PiUiEffect) => void>();
  private readonly waitingEffects: PiUiEffect[] = [];

  constructor(private readonly port: PiUiPort) {
    port.onRequest((request) => this.receive(request));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = (): PiUiState => this.state;
  /** Takes effects as they come; those that came while nothing listened arrive first. */
  onEffect(listener: (effect: PiUiEffect) => void): () => void {
    this.effectListeners.add(listener);
    for (const effect of this.waitingEffects.splice(0)) listener(effect);
    return () => this.effectListeners.delete(listener);
  }

  /** Answers the open question `response` is for; false when it is for none of Pi's. */
  answer(response: DialogResponse): boolean {
    const question = this.state.questions.find(({ request }) => request.id === response.id)?.request;
    if (!question) return false;
    this.port.respond(
      response.cancelled
        ? { type: "extension_ui_response", id: question.id, cancelled: true }
        : question.method === "confirm"
          ? { type: "extension_ui_response", id: question.id, confirmed: response.value === "Yes" }
          : {
              type: "extension_ui_response",
              id: question.id,
              value:
                question.method === "select"
                  ? (question.options.find((option) => plain(option) === response.value) ??
                    response.value ??
                    "")
                  : (response.value ?? ""),
            },
    );
    this.set({ questions: this.state.questions.filter(({ request }) => request.id !== question.id) });
    return true;
  }
  /** Cancels each question whose deadline has passed by `now`. */
  expire(now: number): void {
    const expired = this.state.questions.filter(({ deadline }) => deadline !== undefined && deadline <= now);
    if (!expired.length) return;
    for (const { request } of expired)
      this.port.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
    this.set({ questions: this.state.questions.filter((question) => !expired.includes(question)) });
  }

  private receive(request: PiUiRequest): void {
    switch (request.method) {
      case "notify":
        this.effect({ kind: "notify", level: request.notifyType ?? "info", text: plain(request.message) });
        break;
      case "setStatus":
        this.status(request.statusKey, request.statusText);
        break;
      case "setWidget":
        this.set({
          widgets: {
            ...this.state.widgets,
            [request.widgetKey]: {
              lines: (request.widgetLines ?? []).map(plain),
              placement: request.widgetPlacement ?? "aboveEditor",
            },
          },
        });
        break;
      case "setTitle":
        this.effect({ kind: "title", title: plain(request.title) });
        break;
      case "set_editor_text":
        this.effect({ kind: "draft", text: request.text });
        break;
      default:
        this.set({
          questions: [
            ...this.state.questions,
            {
              request,
              ...("timeout" in request && request.timeout ? { deadline: Date.now() + request.timeout } : {}),
            },
          ],
        });
    }
  }
  private status(key: string, text: string | undefined): void {
    if (UNSHOWN.has(key)) return;
    if (key === RUNTIME_STATUS) {
      // A runtime's start says where it works; its end takes what its extensions showed with it.
      if (text === undefined) this.reset();
    } else if (key === FAST_STATUS) this.set({ fast: Boolean(text) });
    else if (key === USAGE_STATUS) this.set({ usage: decodeUsage(text) });
    else this.set({ statuses: { ...this.state.statuses, [key]: extensionStatus(key, text) } });
  }
  private reset(): void {
    for (const { request } of this.state.questions)
      this.port.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
    this.state = EMPTY;
    this.changed();
  }
  private set(patch: Partial<PiUiState>): void {
    this.state = { ...this.state, ...patch };
    this.changed();
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private effect(effect: PiUiEffect): void {
    if (!this.effectListeners.size) this.waitingEffects.push(effect);
    else for (const listener of this.effectListeners) listener(effect);
  }
}

const stores = new WeakMap<PiUiPort, PiUiStore>();

/** The one store of `port`'s extension UI, made on first use. */
export function piUiStore(port: PiUiPort): PiUiStore {
  let store = stores.get(port);
  if (!store) {
    store = new PiUiStore(port);
    stores.set(port, store);
  }
  return store;
}
