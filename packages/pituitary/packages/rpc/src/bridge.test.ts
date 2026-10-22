import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Bridge } from "../bridge/extension.ts";
import { BridgeHost, type CustomView, type BridgeHost as Host } from "./bridge.ts";
import { BRIDGE_SOCKET_ENV, BRIDGE_TOKEN_ENV, encodeRecord, recordReader } from "./bridge-protocol.ts";

type Factory = Parameters<ExtensionUIContext["custom"]>[0];
type Component = Awaited<ReturnType<Factory>>;
type Tui = Parameters<Factory>[0];

const opened: { host: Host; bridge: Bridge }[] = [];

afterEach(() => {
  for (const { host, bridge } of opened.splice(0)) {
    bridge.close();
    host.close();
  }
});

async function until<T>(read: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function pair() {
  const host = new BridgeHost();
  host.resize(40, 10);
  const env = host.env();
  const bridge = new Bridge(env[BRIDGE_SOCKET_ENV] ?? "", env[BRIDGE_TOKEN_ENV] ?? "", {
    keybindings: async () => ({}) as never,
  });
  opened.push({ host, bridge });
  const widgets: (string[] | undefined)[] = [];
  const notices: string[] = [];
  const ui = bridge.wrap({
    theme: {},
    notify: (message: string) => notices.push(message),
    setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
  } as unknown as ExtensionUIContext);
  let views: readonly CustomView[] = [];
  host.onChange((next) => {
    views = next;
  });
  const latest = () => views.at(-1);
  return { host, bridge, ui, widgets, notices, latest };
}

const component = (lines: () => string[], input?: (data: string) => void): Component => ({
  render: () => lines(),
  handleInput: input,
  invalidate: () => {},
});

const settleWithin = <T>(promise: Promise<T>, ms = 2000) =>
  Promise.race([promise, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms))]);

describe("recordReader", () => {
  test("a character split across chunks arrives whole", () => {
    const records: { text: string }[] = [];
    const read = recordReader<{ text: string }>((record) => records.push(record));
    const bytes = Buffer.from(encodeRecord({ type: "frame", id: "x", lines: ["─"] }));
    const split = bytes.indexOf(Buffer.from("─")) + 1;
    read(bytes.subarray(0, split));
    read(bytes.subarray(split));
    expect(records).toEqual([{ type: "frame", id: "x", lines: ["─"] } as never]);
  });
});

describe("Bridge", () => {
  test("a component opened before the connection is accepted waits for it, then takes keys", async () => {
    const { ui, host, latest } = pair();
    const result = ui.custom<string>((_tui, _theme, _keys, done) =>
      component(
        () => ["pick me"],
        (data) => data === "\r" && done("picked"),
      ),
    );
    const view = await until(() => (latest()?.lines.length ? latest() : undefined));
    expect(view.lines).toEqual(["pick me"]);
    host.input(view.id, "\r");
    expect(await settleWithin(result)).toBe("picked");
  });

  test("a frame of many multi-byte rows arrives intact", async () => {
    const { ui, latest } = pair();
    const rows = Array.from({ length: 2000 }, () => "─".repeat(40));
    void ui.custom(() => component(() => rows));
    const view = await until(() => (latest()?.lines.length ? latest() : undefined));
    expect(view.lines).toEqual(rows);
  });

  test("a component that resolves after pituitary went away resolves with nothing", async () => {
    const { ui, host } = pair();
    const result = ui.custom(
      () =>
        new Promise<Component>((resolve) => {
          host.close();
          setTimeout(() => resolve(component(() => ["late"])), 50);
        }),
    );
    expect(await settleWithin(result)).toBeUndefined();
  });

  test("an open component resolves with nothing when pituitary goes away", async () => {
    const { ui, host, latest } = pair();
    const result = ui.custom(() => component(() => ["open"]));
    await until(() => latest());
    host.close();
    expect(await settleWithin(result)).toBeUndefined();
  });

  test("a connection without the token is dropped, and the live one keeps drawing", async () => {
    const { ui, host, latest } = pair();
    const result = ui.custom<string>((_tui, _theme, _keys, done) =>
      component(
        () => ["live"],
        (data) => done(data),
      ),
    );
    const view = await until(() => latest());
    const intruder = connect(host.path);
    const refused = new Promise<void>((resolve) => intruder.on("close", () => resolve()));
    intruder.on("error", () => {});
    intruder.write(encodeRecord({ type: "hello", token: "guess" }));
    await refused;
    expect(latest()?.id).toBe(view.id);
    host.input(view.id, "still here");
    expect(await settleWithin(result)).toBe("still here");
  });

  test("keys go to the component a component gives focus to", async () => {
    const { ui, host, latest } = pair();
    const heard: string[] = [];
    void ui.custom((tui: Tui) => {
      const child = component(
        () => [],
        (data) => heard.push(`child ${data}`),
      );
      tui.setFocus(child);
      return component(
        () => ["root"],
        (data) => heard.push(`root ${data}`),
      );
    });
    const view = await until(() => latest());
    host.input(view.id, "x");
    await until(() => (heard.length ? heard : undefined));
    expect(heard).toEqual(["child x"]);
  });

  test("hiding an overlay twice leaves the other overlays in place", async () => {
    const { ui, latest } = pair();
    let hideFirst = () => {};
    void ui.custom((tui: Tui) => {
      const first = tui.showOverlay(component(() => ["first"]));
      tui.showOverlay(component(() => ["second"]));
      hideFirst = () => first.hide();
      return component(() => ["root"]);
    });
    await until(() => (latest()?.lines[0] === "second" ? true : undefined));
    hideFirst();
    hideFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(latest()?.lines).toEqual(["second"]);
  });

  test("a widget cleared while a redraw is queued stays cleared", async () => {
    const { ui, widgets } = pair();
    let redraw = () => {};
    ui.setWidget("gauge", (tui: Tui) => {
      redraw = () => tui.requestRender();
      return component(() => ["gauge"]);
    });
    redraw();
    ui.setWidget("gauge", undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(widgets.at(-1)).toBeUndefined();
  });
});

describe("usage limits", () => {
  test("only a response's limit headers cross the bridge, even when sent before pituitary accepts it", async () => {
    const { host, bridge } = pair();
    const heard: Record<string, string>[] = [];
    host.onLimits((_limits, headers) => heard.push(headers));
    bridge.limits({
      "anthropic-ratelimit-unified-5h-utilization": "0.4",
      "anthropic-ratelimit-unified-5h-reset": "1900000000",
      "set-cookie": "session=secret",
      "request-id": "req_123",
      authorization: "Bearer secret",
    });
    const headers = await until(() => heard[0]);
    expect(headers).toEqual({
      "anthropic-ratelimit-unified-5h-utilization": "0.4",
      "anthropic-ratelimit-unified-5h-reset": "1900000000",
    });
    expect(host.limits()?.windows).toEqual([{ id: "5h", utilization: 0.4, resetsAt: 1_900_000_000_000 }]);
  });

  test("a response without limit headers sends nothing", async () => {
    const { host, bridge, ui, latest } = pair();
    let heard = 0;
    host.onLimits(() => heard++);
    bridge.limits({ "content-type": "text/event-stream" });
    // A component opening proves the connection carried everything sent before it.
    void ui.custom(() => component(() => ["after"]));
    await until(() => latest());
    expect(heard).toBe(0);
  });

  test("pituitary keeps only limit headers whatever the other end sends", async () => {
    const host = new BridgeHost();
    const env = host.env();
    const heard: Record<string, string>[] = [];
    host.onLimits((_limits, headers) => heard.push(headers));
    const socket = connect(env[BRIDGE_SOCKET_ENV] ?? "");
    socket.on("error", () => {});
    socket.write(encodeRecord({ type: "hello", token: env[BRIDGE_TOKEN_ENV] ?? "" }));
    socket.write(
      encodeRecord({
        type: "limits",
        headers: { "anthropic-ratelimit-unified-status": "allowed", cookie: "secret" },
      }),
    );
    const headers = await until(() => heard[0]);
    expect(headers).toEqual({ "anthropic-ratelimit-unified-status": "allowed" });
    socket.destroy();
    host.close();
  });
});
