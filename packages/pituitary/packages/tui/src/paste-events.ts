import type { PasteMetadata } from "@opentui/core";

/** The renderer's connection to the terminal, as paste events use it. */
export interface Terminal {
  writeOut(chunk: string): boolean;
  subscribeOsc(handler: (sequence: string) => void): () => void;
  prependInputHandler(handler: (sequence: string) => boolean): void;
  removeInputHandler(handler: (sequence: string) => boolean): void;
  keyInput: { processPaste(bytes: Uint8Array, metadata?: PasteMetadata): void };
  on(event: "destroy", listener: () => void): unknown;
  off(event: "destroy", listener: () => void): unknown;
}

/** Image types a model reads, the most preferred first. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const ON = "\x1b[?5522h";
const OFF = "\x1b[?5522l";
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
const PACKET = /^\x1b\]5522;([^\x07\x1b]*)(?:\x07|\x1b\\)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol bytes
const REPORT = /^\x1b\[\?5522;(\d)\$y$/;

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** An OSC 5522 packet: its metadata keys and its base64 payload. */
function parse(sequence: string): { meta: Map<string, string>; payload: string } | null {
  const body = PACKET.exec(sequence)?.[1];
  if (body === undefined) return null;
  const split = body.indexOf(";");
  const meta = new Map<string, string>();
  for (const entry of (split === -1 ? body : body.slice(0, split)).split(":")) {
    const equals = entry.indexOf("=");
    if (equals > 0) meta.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  return { meta, payload: split === -1 ? "" : body.slice(split + 1) };
}

/**
 * Pastes as the kitty clipboard protocol's paste events deliver them:
 * https://sw.kovidgoyal.net/kitty/clipboard/#allowing-terminal-applications-to-respond-to-paste-events
 *
 * Where the terminal supports them, a paste names the clipboard's types, and this reads an image
 * while the draft takes one, the text otherwise, then hands it on as an ordinary paste.
 */
export class PasteEvents {
  private supported = false;
  private paused = false;
  /** The paste the terminal is announcing: its one-time password and the clipboard's types. */
  private announced: { pw: string | undefined; types: string[] } | null = null;
  /** The read under way, with the data received for it. */
  private reading: { id: string; mimeType: string; chunks: Buffer[] } | null = null;
  private reads = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly terminal: Terminal,
    private readonly takesImages: () => boolean,
  ) {
    terminal.prependInputHandler(this.report);
    this.unsubscribe = terminal.subscribeOsc(this.packet);
    terminal.on("destroy", this.dispose);
    terminal.writeOut("\x1b[?5522$p");
  }

  /** Returns pastes to the terminal while another program runs in it. */
  pause(): void {
    if (this.supported && !this.paused) this.terminal.writeOut(OFF);
    this.paused = true;
  }

  resume(): void {
    if (this.supported && this.paused) this.terminal.writeOut(ON);
    this.paused = false;
  }

  dispose = (): void => {
    this.pause();
    this.unsubscribe();
    this.terminal.removeInputHandler(this.report);
    this.terminal.off("destroy", this.dispose);
  };

  /** The terminal's answer to whether it has paste events. */
  private report = (sequence: string): boolean => {
    const status = REPORT.exec(sequence)?.[1];
    if (status === undefined) return false;
    // 1, 2 and 3 report the mode set, reset, and permanently set; 0 and 4 report no such mode.
    if (status === "1" || status === "2" || status === "3") {
      this.supported = true;
      if (!this.paused) this.terminal.writeOut(ON);
    }
    return true;
  };

  private packet = (sequence: string): void => {
    const packet = parse(sequence);
    if (packet?.meta.get("type") !== "read") return;
    const { meta, payload } = packet;
    const status = meta.get("status");
    const id = meta.get("id");

    // A paste event carries no id: OK opens it, DATA lists the types, DONE closes it.
    if (id === undefined) {
      if (status === "OK") this.announced = { pw: meta.get("pw"), types: [] };
      else if (status === "DATA" && this.announced)
        this.announced.types = Buffer.from(payload, "base64").toString().split(/\s+/).filter(Boolean);
      else if (status === "DONE" && this.announced) {
        this.read(this.announced);
        this.announced = null;
      }
      return;
    }

    if (id !== this.reading?.id) return;
    if (status === "DATA") this.reading.chunks.push(Buffer.from(payload, "base64"));
    else if (status === "DONE") {
      const { mimeType, chunks } = this.reading;
      this.reading = null;
      this.terminal.keyInput.processPaste(Buffer.concat(chunks), {
        mimeType,
        kind: mimeType.startsWith("image/") ? "binary" : "text",
      });
    } else if (status?.startsWith("E")) this.reading = null;
  };

  /** Asks for the announced paste's image, while the draft takes one, or its text. */
  private read({ pw, types }: { pw: string | undefined; types: string[] }): void {
    const image = this.takesImages() ? IMAGE_TYPES.find((type) => types.includes(type)) : undefined;
    const mimeType = image ?? types.find((type) => type === "text/plain" || type.startsWith("text/plain;"));
    if (!mimeType) return;
    const id = `pituitary-${++this.reads}`;
    this.reading = { id, mimeType, chunks: [] };
    // The event's one-time password lets the read through without a permission prompt.
    const password = pw ? `:pw=${pw}:name=${base64("Paste event")}` : "";
    this.terminal.writeOut(`\x1b]5522;type=read${password}:id=${id};${base64(mimeType)}\x1b\\`);
  }
}
