import * as profile from "../profile.ts";
import { BOOTSTRAP, HIGHLIGHTS } from "./bootstrap.ts";
import { NvimRpc } from "./rpc.ts";
import { type Frame, Screen } from "./screen.ts";

/**
 * The draft as nvim holds it. Rows count from 0 and columns are UTF-16 offsets into
 * their line, so they index JavaScript strings directly.
 */
export interface Draft {
  lines: string[];
  row: number;
  col: number;
  /** nvim's mode code: `i`, `n`, `v`, `V`, `no`, `c`, and the rest of `:help mode()`. */
  mode: string;
  /** Whether the cursor is on the first of the screen rows the draft wraps onto. */
  onFirstRow: boolean;
  /** Whether the cursor is on the last of the screen rows the draft wraps onto. */
  onLastRow: boolean;
}

export const EMPTY: Draft = { lines: [""], row: 0, col: 0, mode: "i", onFirstRow: true, onLastRow: true };

/** The draft as one string. */
export function textOf(draft: Draft): string {
  return draft.lines.join("\n");
}

/** The cursor as an offset into `textOf(draft)`. */
export function offsetOf(draft: Draft): number {
  let offset = 0;
  for (let row = 0; row < draft.row; row++) offset += (draft.lines[row]?.length ?? 0) + 1;
  return offset + draft.col;
}

/** The nvim this app embeds: a pinned build in the package, the one on PATH otherwise. */
export function nvimCommand(): string {
  return process.env.PITUITARY_NVIM || "nvim";
}

/**
 * How often an unanswered request asks nvim whether a half-typed command, such as a count
 * or the character after `f`, is what holds it. A busy nvim answers late too, so the
 * wait alone says nothing.
 */
const POLL_MS = 40;

/**
 * The UI the engine attaches as: `:help ui-option`. ext_hlstate names the rows past the draft's
 * end, ext_messages keeps messages and the command line off the grid, and ext_termcolors leaves
 * the background to the terminal.
 */
const UI = { ext_linegrid: true, ext_hlstate: true, ext_messages: true, ext_termcolors: true };

type Reported = Draft & { seq: number };

let spare: DraftEngine | null = null;

/** Starts nvim ahead of the first editor, so it is ready by the time the first frame draws. */
export function prewarm(): void {
  spare ??= new DraftEngine();
}

/** The engine `prewarm` started, or a fresh one. */
export function takeEngine(): DraftEngine {
  const engine = spare ?? new DraftEngine();
  spare = null;
  return engine;
}

/**
 * An embedded nvim holding the draft and drawing it. nvim owns the text, every edit to it,
 * and how it looks on screen; this mirrors the draft nvim reports, keeps the screen it
 * draws, and feeds it keys.
 *
 * Keys go in through nvim_input, which nvim takes as soon as it reads it, so a count or
 * an operator can wait on the next key. nvim answers an API request only once it has used
 * every key before it, so a request reads and edits the draft in order with typing as
 * long as no later key overtakes it: keys sent while an edit is outstanding wait for it.
 */
export class DraftEngine {
  private readonly rpc: NvimRpc;
  private current: Draft = EMPTY;
  /** Replacements asked of nvim; a report from before the latest one is stale. */
  private asked = 0;
  /** Keys sent, and how many of them the latest answered read had seen. */
  private sent = 0;
  private synced = 0;
  private settling: Promise<void> | null = null;
  /** A half-typed command holds nvim: set when nvim says so of a read it has not answered, cleared when it answers. */
  private held = false;
  /** Everything sent to nvim, in order: keys run straight after the edit before them. */
  private chain: Promise<unknown>;
  /** Edits in the chain not yet answered, the bootstrap among them. */
  private outstanding = 1;
  private readonly listeners = new Set<(draft: Draft) => void>();
  private readonly screen = new Screen();
  private shown: Frame | null = null;
  private readonly painters = new Set<(frame: Frame) => void>();
  /** The screen's size in cells, once it has one; the first size attaches it. */
  private size: { width: number; height: number } | null = null;
  /** Requests that size the screen, each after the one before. */
  private sizing: Promise<unknown>;
  /** Resolves once nvim runs the bootstrap, rejects when it fails to start. */
  readonly ready: Promise<void>;

  constructor(command = nvimCommand()) {
    this.rpc = new NvimRpc(command, ["--embed", "--headless", "--clean", "-n", "-i", "NONE"]);
    profile.mark("nvim-spawned");
    this.rpc.onNotification((method, params) => {
      if (method === "draft") this.receive(params[0] as Reported);
      else if (method === "redraw") this.redraw(params);
    });
    this.ready = this.rpc
      .request("nvim_get_api_info")
      .then((info) => this.lua(BOOTSTRAP, [(info as [number])[0], HIGHLIGHTS]))
      .then(() => profile.mark("nvim-ready"));
    // A failure to start also closes the session, which is where callers hear of it.
    this.ready.catch(() => {});
    this.sizing = this.ready;
    this.chain = this.ready.then(
      () => {
        this.outstanding--;
      },
      () => {},
    );
  }

  get draft(): Draft {
    return this.current;
  }

  /** The screen as nvim last finished drawing it, or null until it first has. */
  get frame(): Frame | null {
    return this.shown;
  }

  /**
   * True while nvim holds a half-typed command, such as a count, a register name, or the
   * character after `f` or ctrl+v, so the next key belongs to that command.
   */
  get pending(): boolean {
    return this.held;
  }

  /** True while keys have gone to nvim that the draft may not show yet. */
  get busy(): boolean {
    return this.synced < this.sent || this.outstanding > 0;
  }

  onChange(listener: (draft: Draft) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` with each frame nvim finishes drawing. */
  onFrame(listener: (frame: Frame) => void): () => void {
    this.painters.add(listener);
    return () => this.painters.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    return this.rpc.onClose(listener);
  }

  /** Has nvim draw on a screen `width` cells by `height` rows. Nothing draws before the first size. */
  resize(width: number, height: number): void {
    if (width < 1 || height < 1 || (this.size?.width === width && this.size.height === height)) return;
    const [method, params] = this.size
      ? ["nvim_ui_try_resize", [width, height]]
      : ["nvim_ui_attach", [width, height, UI]];
    this.size = { width, height };
    // A failure means nvim has gone, which the close listeners hear of.
    this.sizing = this.sizing.then(() => this.rpc.request(method, params)).catch(() => {});
  }

  /** Sets the text an empty draft shows while inserting. */
  placeholder(text: string): void {
    this.ready.then(() => this.lua("pi_draft.placeholder(...)", [text])).catch(() => {});
  }

  /** Feeds keys in nvim's notation, such as `<C-w>` or `ci"`. */
  input(keys: string): void {
    this.sent++;
    if (this.outstanding === 0) this.rpc.notify("nvim_input", [keys]);
    else this.chain = this.chain.then(() => this.rpc.notify("nvim_input", [keys]));
    void this.settle();
  }

  /** Resolves once the draft shows every key sent so far, or a half-typed command holds nvim. */
  settle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    this.settling ??= (async () => {
      try {
        while (this.busy) {
          await this.chain;
          const upTo = this.sent;
          const read = this.lua("return pi_draft.state()").then((reported) => {
            if (this.held) {
              this.held = false;
              this.emit();
            }
            this.receive(reported as Reported);
          });
          if (await this.blocked(read)) {
            this.held = true;
            this.emit();
          }
          this.synced = Math.max(this.synced, upTo);
        }
      } catch {
        // nvim has gone; the close listeners hear why.
      } finally {
        this.settling = null;
      }
    })();
    return this.settling;
  }

  /** Inserts text as a paste, whatever the mode. */
  paste(text: string): void {
    this.inOrder(() => this.rpc.request("nvim_paste", [text.replace(/\r\n?/g, "\n"), false, -1])).catch(
      () => {},
    );
  }

  /** Replaces the draft, cursor at `cursor` (the end by default), and enters insert mode. */
  set(text: string, cursor = text.length): void {
    const before = text.slice(0, cursor).split("\n");
    const row = before.length - 1;
    const col = before[row]?.length ?? 0;
    const lines = text.split("\n");
    this.asked++;
    this.current = { ...EMPTY, lines, row, col };
    this.announce();
    this.fromNormal(() => this.lua("pi_draft.set(...)", [lines, row, col])).catch(() => {});
  }

  /** The draft as it stands after every key sent so far, cleared for the next one. */
  take(): Promise<string> {
    this.asked++;
    // Keep the last acknowledged draft until nvim confirms the clear. If it dies while
    // answering, the plain editor must still be able to recover what was on screen.
    return this.fromNormal(() => this.lua("return pi_draft.take()")).then((text) => String(text ?? ""));
  }

  close(): void {
    this.rpc.close();
  }

  private lua(code: string, args: unknown[] = []): Promise<unknown> {
    return this.rpc.request("nvim_exec_lua", [code, args]);
  }

  /** Runs a request after every key sent before it and before every key sent after it. */
  private inOrder<T>(call: () => Promise<T>): Promise<T> {
    this.outstanding++;
    const answer = this.chain.then(async () => {
      const pending = call();
      // A half-typed command holds the request until escape abandons it.
      if (await this.blocked(pending)) this.rpc.notify("nvim_input", ["<Esc>"]);
      return pending;
    });
    this.chain = answer
      .catch(() => {})
      .then(() => {
        this.outstanding--;
      });
    return answer;
  }

  /** As `inOrder`, having first left whatever mode or half-typed command nvim is in. */
  private fromNormal<T>(call: () => Promise<T>): Promise<T> {
    return this.inOrder(() => {
      this.rpc.notify("nvim_input", ["<C-\\><C-n>"]);
      return call();
    });
  }

  /**
   * Resolves false once `request` is answered, or true once nvim says a half-typed
   * command holds it. nvim_get_mode is answered even while nvim waits on such a command.
   */
  private async blocked(request: Promise<unknown>): Promise<boolean> {
    let answered = false;
    const done = request.then(
      () => (answered = true),
      () => (answered = true),
    );
    for (;;) {
      if (await Promise.race([done, poll()])) return false;
      const mode = (await this.rpc.request("nvim_get_mode")) as { blocking: boolean };
      if (answered) return false;
      if (mode.blocking) return true;
    }
  }

  private receive(state: Reported): void {
    if (state.seq < this.asked) return;
    const { seq: _, ...draft } = state;
    // A read and nvim's own report often carry the same state; one render is enough.
    if (same(draft, this.current)) return;
    profile.mark("nvim-first-draft");
    this.current = draft;
    this.emit();
  }

  private redraw(batch: unknown[]): void {
    const frame = this.screen.apply(batch);
    if (!frame) return;
    profile.mark("nvim-first-frame");
    this.shown = frame;
    for (const listener of this.painters) listener(frame);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }

  /** Emits once the caller's stack unwinds, so a listener may render at once even from inside a render. */
  private announce(): void {
    queueMicrotask(() => this.emit());
  }
}

function poll(): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), POLL_MS));
}

function same(a: Draft, b: Draft): boolean {
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.mode === b.mode &&
    a.onFirstRow === b.onFirstRow &&
    a.onLastRow === b.onLastRow &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index])
  );
}
