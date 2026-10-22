/**
 * pituitary's companion extension, loaded into every pi it runs.
 *
 * Over RPC, pi hands extensions a UI context whose `custom()` resolves at once with
 * nothing and whose `setWidget()` drops component factories. With `PITUITARY_BRIDGE` set, this
 * extension gives every extension a context that runs those components here and streams
 * what they draw to pituitary. With `PITUITARY_HANDOFF` set, stock pi opens with that command
 * in its editor and records the session it ends on, for pituitary to carry on from.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { type ExtensionAPI, ExtensionRunner, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_COMMAND_PREFIX,
  BRIDGE_SOCKET_ENV,
  BRIDGE_TOKEN_ENV,
  type BridgeMessage,
  encodeRecord,
  HANDOFF_ENV,
  HANDOFF_RESULT_ENV,
  type HostMessage,
  recordReader,
} from "../src/bridge-protocol.ts";
import { limitHeaders } from "../src/limits.ts";

type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomOptions = NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;
type TUI = Parameters<CustomFactory>[0];
type Theme = Parameters<CustomFactory>[1];
type Keybindings = Parameters<CustomFactory>[2];
type Component = Awaited<ReturnType<CustomFactory>>;
type OverlayHandle = Parameters<NonNullable<CustomOptions["onHandle"]>>[0];
type OverlayOptions = Exclude<NonNullable<CustomOptions["overlayOptions"]>, () => unknown>;
type WidgetFactory = NonNullable<Parameters<ExtensionUIContext["setWidget"]>[1]>;
type WidgetOptions = Parameters<ExtensionUIContext["setWidget"]>[2];
type InputListener = Parameters<TUI["addInputListener"]>[0];

/** Resolved through pi's own module table, so the manager is the one pi's components consult. */
const PI_TUI = "@earendil-works/pi-tui";

/** Width a component draws at before pituitary reports its size. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/** How long a component waits for pituitary to accept the connection. */
const CONNECT_MS = 10_000;

/**
 * Shared by every copy of this module pi loads: `/reload` imports it afresh, and the
 * environment it was configured from is cleared on first load.
 */
const STATE = Symbol.for("pituitary.bridge");
interface Shared {
  original: ExtensionRunner["setUIContext"];
  bridge: Bridge | null;
  handoff: { text: string; result: string | undefined; offered: boolean } | null;
}
const shared = globalThis as typeof globalThis & { [STATE]?: Shared };

/** An overlay a component opened, and what held the keyboard before it. */
interface Overlay {
  component: Component;
  hidden: boolean;
  capturing: boolean;
  previous: Component | null;
}

/** A component pituitary shows while it holds the keyboard. */
interface Session {
  root: Component;
  overlays: Overlay[];
  /** The component keys go to, as pi's TUI routes them. */
  focused: Component | null;
  listeners: Set<InputListener>;
  width(): number;
  finish(result: unknown): void;
}

/** A widget built from a component, redrawn into string rows. */
interface Widget {
  component: Component;
  draw(): void;
}

export interface BridgeOptions {
  /** The keybindings each component is built with; pi's own by default. */
  keybindings?: () => Promise<Keybindings>;
}

const blank = (): Component => ({ render: () => [], invalidate: () => {} });

export class Bridge {
  private readonly socket: Socket;
  private status: "connecting" | "open" | "closed" = "connecting";
  private readonly waiting = new Set<(open: boolean) => void>();
  private readonly sessions = new Map<string, Session>();
  private readonly widgets = new Map<string, Widget>();
  private columns = DEFAULT_COLUMNS;
  private rows = DEFAULT_ROWS;
  private readonly scheduled = new Set<string>();
  /** Limit headers that arrived before pituitary accepted the connection, sent once it does. */
  private heldLimits: Record<string, string> | null = null;

  constructor(
    path: string,
    token: string,
    private readonly options: BridgeOptions = {},
  ) {
    this.socket = connect(path);
    this.socket.on("connect", () => this.socket.write(encodeRecord({ type: "hello", token })));
    this.socket.on(
      "data",
      recordReader<HostMessage>((message) => {
        if (message.type === "welcome") {
          this.status = "open";
          this.settle(true);
          if (this.heldLimits) this.send({ type: "limits", headers: this.heldLimits });
          this.heldLimits = null;
        } else if (this.status === "open") this.receive(message);
      }),
    );
    this.socket.on("error", () => this.drop());
    this.socket.on("close", () => this.drop());
  }

  get closed(): boolean {
    return this.status === "closed";
  }

  close(): void {
    this.drop();
    for (const widget of this.widgets.values()) widget.component.dispose?.();
    this.widgets.clear();
    this.socket.destroy();
  }

  /** Passes on the usage-limit headers of a provider response; every other header stays in pi. */
  limits(headers: Readonly<Record<string, unknown>>): void {
    const kept = limitHeaders(headers);
    if (Object.keys(kept).length === 0) return;
    if (this.status === "connecting") this.heldLimits = kept;
    else this.send({ type: "limits", headers: kept });
  }

  /** The context every extension receives: pi's RPC context with components carried over the bridge. */
  wrap(ui: ExtensionUIContext): ExtensionUIContext {
    const setWidget = ui.setWidget.bind(ui);
    return {
      ...ui,
      get theme() {
        return ui.theme;
      },
      custom: <T>(factory: CustomFactory, options?: CustomOptions) =>
        this.custom(factory, options, ui) as Promise<T>,
      setWidget: ((key: string, content: string[] | WidgetFactory | undefined, options?: WidgetOptions) => {
        this.widgets.get(key)?.component.dispose?.();
        this.widgets.delete(key);
        if (typeof content !== "function") {
          setWidget(key, content, options);
          return;
        }
        this.widget(key, content, ui.theme, (lines) => setWidget(key, lines, options));
      }) as ExtensionUIContext["setWidget"],
    };
  }

  /** Resolves true once pituitary accepts the connection, false once it will not. */
  private ready(): Promise<boolean> {
    if (this.status !== "connecting") return Promise.resolve(this.status === "open");
    return new Promise((resolve) => {
      const done = (open: boolean) => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve(open);
      };
      const timer = setTimeout(() => done(false), CONNECT_MS);
      this.waiting.add(done);
    });
  }

  private settle(open: boolean): void {
    for (const done of [...this.waiting]) done(open);
  }

  private async custom(
    factory: CustomFactory,
    options: CustomOptions | undefined,
    ui: ExtensionUIContext,
  ): Promise<unknown> {
    if (!(await this.ready())) {
      ui.notify("pituitary is not connected, so an extension's own screen could not open", "warning");
      return undefined;
    }
    const keybindings = await (this.options.keybindings ?? loadKeybindings)();
    const id = randomUUID();
    return new Promise((resolve) => {
      let finished = false;
      let shown = false;
      const finish = (result: unknown) => {
        if (finished) return;
        finished = true;
        if (shown) {
          this.sessions.delete(id);
          session.root.dispose?.();
          this.send({ type: "close", id });
        }
        resolve(result);
      };
      const session: Session = {
        root: blank(),
        overlays: [],
        focused: null,
        listeners: new Set(),
        width: () => {
          const spec =
            typeof options?.overlayOptions === "function"
              ? options.overlayOptions()
              : options?.overlayOptions;
          return options?.overlay ? sizeOf(spec, this.columns) : this.columns;
        },
        finish,
      };
      const requestRender = () => this.schedule(id);
      Promise.resolve()
        .then(() => factory(this.host(session, requestRender), ui.theme, keybindings, finish))
        .then((root) => {
          // The component resolved after it finished, or after pituitary went away.
          if (finished || this.status !== "open") {
            root.dispose?.();
            finish(undefined);
            return;
          }
          session.root = root;
          if (!session.focused) setFocus(session, root);
          shown = true;
          this.sessions.set(id, session);
          options?.onHandle?.(handleFor(session, root, requestRender));
          this.send({ type: "open", id });
          this.draw(id);
        })
        .catch(() => finish(undefined));
    });
  }

  private widget(key: string, factory: WidgetFactory, theme: Theme, show: (lines: string[]) => void): void {
    const session: Session = {
      root: blank(),
      overlays: [],
      focused: null,
      listeners: new Set(),
      width: () => this.columns,
      finish: () => {},
    };
    let queued = false;
    // A draw queued before the widget was cleared or replaced must not bring it back.
    const draw = () => {
      queued = false;
      if (this.widgets.get(key)?.component === session.root) show(session.root.render(this.columns));
    };
    const host = this.host(session, () => {
      if (queued) return;
      queued = true;
      setImmediate(draw);
    });
    session.root = factory(host, theme);
    this.widgets.set(key, { component: session.root, draw });
    draw();
  }

  /** The TUI a component is built against: it draws on request and reports the bridge's size. */
  private host(session: Session, requestRender: () => void): TUI {
    const bridge = this;
    const terminal = {
      start() {},
      stop() {},
      async drainInput() {},
      write() {},
      get columns() {
        return bridge.columns;
      },
      get rows() {
        return bridge.rows;
      },
      get kittyProtocolActive() {
        return false;
      },
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    };
    const host = {
      mode: "regular" as const,
      children: [] as Component[],
      terminal,
      fullRedraws: 0,
      render: (width: number) => session.root.render(width),
      invalidate: () => session.root.invalidate(),
      addChild() {},
      removeChild() {},
      clear() {},
      getShowHardwareCursor: () => false,
      setShowHardwareCursor() {},
      getClearOnShrink: () => false,
      setClearOnShrink() {},
      setFocus(component: Component | null) {
        setFocus(session, component);
      },
      showOverlay(component: Component, options?: OverlayOptions) {
        const entry: Overlay = {
          component,
          hidden: false,
          capturing: !options?.nonCapturing,
          previous: session.focused,
        };
        session.overlays.push(entry);
        if (entry.capturing) setFocus(session, component);
        requestRender();
        return handleFor(session, component, requestRender, entry);
      },
      hideOverlay() {
        const top = session.overlays.at(-1);
        if (top && removeOverlay(session, top)) requestRender();
      },
      hasOverlay: () => session.overlays.length > 0,
      start() {},
      stop() {},
      renderNow: () => requestRender(),
      requestRender: () => requestRender(),
      addInputListener(listener: InputListener) {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
      removeInputListener(listener: InputListener) {
        session.listeners.delete(listener);
      },
      onTerminalColorSchemeChange: () => () => {},
      setTerminalColorSchemeNotifications() {},
      queryTerminalBackgroundColor: async () => undefined,
      queryTerminalColorScheme: async () => undefined,
    };
    return host as unknown as TUI;
  }

  private receive(message: HostMessage): void {
    switch (message.type) {
      case "welcome":
        return;
      case "size":
        this.columns = Math.max(10, message.columns);
        this.rows = Math.max(3, message.rows);
        for (const id of this.sessions.keys()) this.draw(id);
        for (const widget of this.widgets.values()) widget.draw();
        return;
      case "input": {
        const session = this.sessions.get(message.id);
        if (!session) return;
        this.schedule(message.id);
        let data: string | undefined = message.data;
        for (const listener of session.listeners) {
          const result = listener(data);
          if (result?.consume) return;
          if (result?.data !== undefined) data = result.data;
        }
        (session.focused ?? target(session)).handleInput?.(data);
        return;
      }
      case "cancel":
        this.sessions.get(message.id)?.finish(undefined);
        return;
    }
  }

  private schedule(id: string): void {
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    setImmediate(() => {
      this.scheduled.delete(id);
      this.draw(id);
    });
  }

  private draw(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.send({ type: "frame", id, lines: target(session).render(session.width()) });
  }

  private send(message: BridgeMessage): void {
    if (this.status === "open" && !this.socket.destroyed) this.socket.write(encodeRecord(message));
  }

  /** pituitary is gone, so nothing can answer an open component; each resolves with nothing. */
  private drop(): void {
    this.status = "closed";
    this.settle(false);
    for (const session of [...this.sessions.values()]) session.finish(undefined);
  }
}

/** The component that draws: the topmost visible overlay, or the root. */
function target(session: Session): Component {
  for (let index = session.overlays.length - 1; index >= 0; index--) {
    const overlay = session.overlays[index];
    if (overlay && !overlay.hidden) return overlay.component;
  }
  return session.root;
}

function setFocus(session: Session, component: Component | null): void {
  const previous = session.focused;
  if (previous && "focused" in previous) (previous as { focused: boolean }).focused = false;
  session.focused = component;
  if (component && "focused" in component) (component as { focused: boolean }).focused = true;
}

/** Where focus returns when `component` gives it up: what held it before, while still shown. */
function restore(session: Session, previous: Component | null): Component {
  const shown = (component: Component | null) =>
    component === session.root ||
    session.overlays.some((each) => each.component === component && !each.hidden);
  if (previous && shown(previous)) return previous;
  for (let index = session.overlays.length - 1; index >= 0; index--) {
    const overlay = session.overlays[index];
    if (overlay && !overlay.hidden && overlay.capturing) return overlay.component;
  }
  return session.root;
}

/** Takes `entry` off the overlay stack; false when it was already gone. */
function removeOverlay(session: Session, entry: Overlay): boolean {
  const index = session.overlays.indexOf(entry);
  if (index < 0) return false;
  session.overlays.splice(index, 1);
  if (session.focused === entry.component) setFocus(session, restore(session, entry.previous));
  return true;
}

function handleFor(
  session: Session,
  component: Component,
  requestRender: () => void,
  entry?: Overlay,
): OverlayHandle {
  return {
    hide() {
      if (entry && removeOverlay(session, entry)) requestRender();
    },
    setHidden(hidden: boolean) {
      if (!entry || entry.hidden === hidden) return;
      entry.hidden = hidden;
      if (hidden && session.focused === component) setFocus(session, restore(session, entry.previous));
      if (!hidden && entry.capturing) setFocus(session, component);
      requestRender();
    },
    isHidden: () => entry?.hidden ?? false,
    focus() {
      setFocus(session, component);
      requestRender();
    },
    unfocus() {
      if (session.focused === component) setFocus(session, restore(session, entry?.previous ?? null));
      requestRender();
    },
    isFocused: () => session.focused === component,
    getBounds: () => undefined,
  };
}

/** Columns an overlay's `width` asks for, out of `columns`. */
function sizeOf(spec: OverlayOptions | undefined, columns: number): number {
  const width = spec?.width;
  const wanted =
    typeof width === "number"
      ? width
      : typeof width === "string" && width.endsWith("%")
        ? Math.floor((columns * Number(width.slice(0, -1))) / 100)
        : columns;
  return Math.max(spec?.minWidth ?? 10, Math.min(columns, wanted));
}

/** Versions of the changelog shown at once. */
const CHANGELOG_VERSIONS = 1;

/** The latest sections of the changelog installed with the running pi. */
function changelog(): string | null {
  let directory = dirname(realpathSync(process.argv[1] ?? "."));
  for (let depth = 0; depth < 6; depth++) {
    const path = join(directory, "CHANGELOG.md");
    if (existsSync(path)) {
      const sections = readFileSync(path, "utf8").split(/^(?=## )/m);
      return sections
        .filter((section) => section.startsWith("## "))
        .slice(0, CHANGELOG_VERSIONS)
        .join("")
        .trim();
    }
    directory = dirname(directory);
  }
  return null;
}

async function loadKeybindings(): Promise<Keybindings> {
  const module = (await import(PI_TUI)) as { getKeybindings(): Keybindings };
  return module.getKeybindings();
}

/**
 * Wraps each RPC-mode context pi installs, for every runner this pi creates. A bridge
 * configured on first load stays connected across reloads.
 */
function install(path: string | undefined, token: string | undefined): Shared {
  const prototype = ExtensionRunner.prototype;
  shared[STATE] ??= { original: prototype.setUIContext, bridge: null, handoff: null };
  const state = shared[STATE];
  if (path && token) {
    state.bridge?.close();
    state.bridge = new Bridge(path, token);
  }
  prototype.setUIContext = function (this: ExtensionRunner, ui, mode) {
    const active = shared[STATE]?.bridge;
    return state.original.call(this, ui && mode === "rpc" && active ? active.wrap(ui) : ui, mode);
  };
  return state;
}

export default function pituitaryBridge(pi: ExtensionAPI): void {
  const path = process.env[BRIDGE_SOCKET_ENV];
  const token = process.env[BRIDGE_TOKEN_ENV];
  const handoff = process.env[HANDOFF_ENV];
  const result = process.env[HANDOFF_RESULT_ENV];
  // Every process pi starts inherits its environment, and none of them may reach the bridge.
  for (const name of [BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, HANDOFF_ENV, HANDOFF_RESULT_ENV])
    delete process.env[name];
  const state = install(path, token);
  if (handoff) state.handoff = { text: handoff, result, offered: false };

  if (state.bridge) {
    pi.on("after_provider_response", (event) => {
      shared[STATE]?.bridge?.limits(event.headers);
    });
    pi.registerCommand(`${BRIDGE_COMMAND_PREFIX}reload`, {
      description: "pituitary: reload extensions, skills, prompts, themes, and context files",
      handler: async (_args, ctx) => {
        if (!ctx.isIdle()) {
          ctx.ui.notify("wait for the current response to finish before reloading", "warning");
          return;
        }
        await ctx.reload();
      },
    });
    pi.registerCommand(`${BRIDGE_COMMAND_PREFIX}tree`, {
      description: "pituitary: move to an entry of the session tree",
      handler: async (args, ctx) => {
        const [targetId = "", mode = ""] = args.trim().split(/\s+/);
        const { cancelled } = await ctx.navigateTree(targetId, { summarize: mode === "summarize" });
        if (cancelled) ctx.ui.notify("an extension kept the session from moving", "warning");
      },
    });
    pi.registerCommand(`${BRIDGE_COMMAND_PREFIX}changelog`, {
      description: "pituitary: show what changed in the latest version of pi",
      handler: async (_args, ctx) => {
        const text = changelog();
        ctx.ui.notify(text ?? "pi's changelog is not installed beside it", text ? "info" : "warning");
      },
    });
  }

  const offer = state.handoff;
  if (offer) {
    pi.on("session_start", (_event, ctx) => {
      if (offer.offered || !ctx.hasUI) return;
      offer.offered = true;
      ctx.ui.setEditorText(offer.text);
      ctx.ui.notify(
        `pituitary: press enter to run ${offer.text}, then quit pi to return to pituitary`,
        "info",
      );
    });
    const file = offer.result;
    if (file) {
      pi.on("session_shutdown", (_event, ctx) => {
        writeFileSync(file, ctx.sessionManager.getSessionFile() ?? "");
      });
    }
  }
}
