import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_SOCKET_ENV,
  BRIDGE_TOKEN_ENV,
  type BridgeMessage,
  encodeRecord,
  type HostMessage,
  recordReader,
} from "./bridge-protocol.ts";
import { type Limits, limitHeaders, readLimits } from "./limits.ts";

/** Path of the companion extension pituitary loads into pi. */
export const BRIDGE_EXTENSION = new URL("../bridge/extension.ts", import.meta.url).pathname;

/** How long a new connection has to present its token. */
const HELLO_MS = 2000;

/** A component an extension opened, as it last drew itself. */
export interface CustomView {
  id: string;
  /** One ANSI-styled string per row. */
  lines: string[];
}

/**
 * pituitary's end of the side channel to the bridge extension.
 *
 * The socket lives in a directory only the operator can enter, so no other user can
 * draw into the UI or read the keys sent to a component. A connection draws only once it
 * presents the token pituitary gave its own pi, so a process that learns the path cannot.
 */
export class BridgeHost {
  private readonly server: Server;
  private readonly directory: string;
  private socket: Socket | null = null;
  /** Includes connections still waiting to identify themselves. */
  private readonly sockets = new Set<Socket>();
  private views: CustomView[] = [];
  private readonly listeners = new Set<(views: readonly CustomView[]) => void>();
  private readonly connects = new Set<() => void>();
  private readonly limitListeners = new Set<
    (limits: Limits | null, headers: Record<string, string>) => void
  >();
  private latestLimits: Limits | null = null;
  private size: { columns: number; rows: number } | null = null;
  private opened = 0;
  private closed = false;
  private readonly token = randomBytes(32).toString("hex");
  readonly path: string;

  constructor() {
    this.directory = mkdtempSync(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "pituitary-"));
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, "bridge.sock");
    this.server = createServer((socket) => this.accept(socket));
    this.server.listen(this.path);
  }

  /** Environment that points the bridge extension at this host. */
  env(): Record<string, string> {
    return { [BRIDGE_SOCKET_ENV]: this.path, [BRIDGE_TOKEN_ENV]: this.token };
  }

  /** Called with every open component, oldest first, whenever one opens, draws, or closes. */
  onChange(listener: (views: readonly CustomView[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.views);
    return () => this.listeners.delete(listener);
  }

  /** Called each time pi's bridge extension connects and proves itself. */
  onConnect(listener: () => void): () => void {
    this.connects.add(listener);
    return () => this.connects.delete(listener);
  }

  /** Called with the usage limits of each provider response pi reports, and the headers they came from. */
  onLimits(listener: (limits: Limits | null, headers: Record<string, string>) => void): () => void {
    this.limitListeners.add(listener);
    return () => this.limitListeners.delete(listener);
  }

  /** The usage limits of the latest provider response that carried any. */
  limits(): Limits | null {
    return this.latestLimits;
  }

  /** How many components have opened, for telling whether a command showed one. */
  opens(): number {
    return this.opened;
  }

  resize(columns: number, rows: number): void {
    if (this.size?.columns === columns && this.size.rows === rows) return;
    this.size = { columns, rows };
    this.send({ type: "size", columns, rows });
  }

  input(id: string, data: string): void {
    this.send({ type: "input", id, data });
  }

  cancel(id: string): void {
    this.send({ type: "cancel", id });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.socket = null;
    this.update([]);
    this.server.close();
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** A connection is held apart until its first record carries the token. */
  private accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let proven = false;
    const timer = setTimeout(() => socket.destroy(), HELLO_MS);
    socket.on(
      "data",
      recordReader<BridgeMessage>((message) => {
        if (socket.destroyed) return;
        if (!message || typeof message !== "object" || typeof message.type !== "string") {
          socket.destroy();
          return;
        }
        if (proven) {
          if (this.socket === socket) this.receive(message);
          return;
        }
        clearTimeout(timer);
        if (message.type !== "hello" || !this.matches(message.token)) {
          socket.destroy();
          return;
        }
        proven = true;
        this.adopt(socket);
      }),
    );
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
      if (this.socket !== socket) return;
      this.socket = null;
      this.update([]);
    });
  }

  /** A restarted pi connects afresh with the same token, and the latest connection draws. */
  private adopt(socket: Socket): void {
    this.socket?.destroy();
    this.socket = socket;
    this.update([]);
    this.send({ type: "welcome" });
    if (this.size) this.send({ type: "size", ...this.size });
    for (const listener of this.connects) listener();
  }

  private matches(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const given = Buffer.from(token);
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private receive(message: BridgeMessage): void {
    switch (message.type) {
      case "open":
        if (typeof message.id !== "string" || this.views.some((view) => view.id === message.id)) return;
        this.opened++;
        this.update([...this.views, { id: message.id, lines: [] }]);
        return;
      case "frame":
        if (!Array.isArray(message.lines) || message.lines.some((line) => typeof line !== "string")) return;
        this.update(
          this.views.map((view) => (view.id === message.id ? { ...view, lines: message.lines } : view)),
        );
        return;
      case "close":
        this.update(this.views.filter((view) => view.id !== message.id));
        return;
      case "limits": {
        // Filtered again here, so pituitary holds only limit headers whatever the other end sends.
        const headers = limitHeaders(
          typeof message.headers === "object" && message.headers ? message.headers : {},
        );
        const limits = readLimits(headers);
        if (limits) this.latestLimits = limits;
        for (const listener of this.limitListeners) listener(limits, headers);
        return;
      }
    }
  }

  private update(views: CustomView[]): void {
    this.views = views;
    for (const listener of this.listeners) listener(views);
  }

  private send(message: HostMessage): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(encodeRecord(message));
  }
}
