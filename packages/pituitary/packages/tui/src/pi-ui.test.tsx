import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { act, createRef } from "react";
import { Dialog, GRACE_MS, type DialogResponse } from "./components/dialog.tsx";
import type { EditorHandle } from "./components/editor.tsx";
import type { PiUiPort, PiUiRequest, PiUiResponse } from "./pi.ts";
import { PiWidgets, usePiUI } from "./pi-ui.tsx";

/** Exercise the frontend protocol without starting an agent or a model. */
function uiPort(initial: PiUiRequest[] = []) {
  const waiting = [...initial];
  let receive: ((request: PiUiRequest) => void) | undefined;
  const responses: PiUiResponse[] = [];
  const port: PiUiPort = {
    onRequest(listener) {
      receive = listener;
      for (const request of waiting.splice(0)) listener(request);
      return () => { receive = undefined; };
    },
    respond(response) {
      responses.push(response);
    },
  };
  return {
    port,
    responses,
    emit(request: PiUiRequest) {
      if (receive) receive(request);
      else waiting.push(request);
    },
  };
}

async function mount(port?: PiUiPort) {
  const environment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const app = await createTestRenderer({ width: 70, height: 24 });
  const root = createRoot(app.renderer);
  const editor = createRef<EditorHandle>();
  const notices: { level: string; text: string }[] = [];
  const notify = (level: "info" | "warning" | "error", text: string) => {
    notices.push({ level, text });
  };
  let ui!: ReturnType<typeof usePiUI>;
  function Probe({ connection }: { connection?: PiUiPort }) {
    ui = usePiUI(connection, editor, app.renderer, notify);
    const dialog = ui.dialogs[0];
    return (
      <box flexDirection="column">
        <PiWidgets widgets={ui.widgets} placement="aboveEditor" />
        {dialog ? <Dialog key={dialog.id} dialog={dialog} behind={ui.dialogs.length - 1} onAnswer={ui.answer} /> : null}
        <PiWidgets widgets={ui.widgets} placement="belowEditor" />
        <text>{ui.statuses.join(" · ")}</text>
      </box>
    );
  }
  const change = async (operation: () => void) => {
    act(() => flushSync(operation));
    await app.renderOnce();
  };
  await change(() => root.render(<Probe connection={port} />));
  return {
    ...app,
    notices,
    state: () => ui,
    change,
    async answer(response: DialogResponse) {
      let handled = false;
      await change(() => { handled = ui.answer(response); });
      return handled;
    },
    async disconnect() {
      await change(() => root.render(<Probe />));
    },
    close() {
      act(() => flushSync(() => root.unmount()));
      app.renderer.destroy();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", environment);
    },
  };
}

test("startup and live confirmations return Pi boolean responses and notifications are terminal safe", async () => {
  const source = uiPort([
    { type: "extension_ui_request", id: "startup", method: "confirm", title: "Allow this tool?", message: "The extension asks first." },
  ]);
  const app = await mount(source.port);
  try {
    expect(app.captureCharFrame()).toContain("Allow this tool?");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 10)); });
    await act(async () => {
      app.mockInput.pressKey("ARROW_DOWN");
      app.mockInput.pressKey("RETURN");
    });
    await app.renderOnce();
    expect(source.responses).toEqual([{ type: "extension_ui_response", id: "startup", confirmed: false }]);
    expect(app.state().dialogs).toHaveLength(0);
    await app.change(() => {
      source.emit({ type: "extension_ui_request", id: "live", method: "confirm", title: "Continue?", message: "Ready." });
      source.emit({ type: "extension_ui_request", id: "notice", method: "notify", notifyType: "warning", message: "\x1b[31mDenied\x1b[0m\x07\nTry again." });
    });
    expect(app.notices).toEqual([{ level: "warning", text: "Denied\nTry again." }]);
    expect(await app.answer({ type: "dialog_response", id: "live", value: "Yes" })).toBe(true);
    expect(source.responses.at(-1)).toEqual({ type: "extension_ui_response", id: "live", confirmed: true });
    expect(await app.answer({ type: "dialog_response", id: "team-question", value: "other owner" })).toBe(false);
  } finally {
    app.close();
  }
});

test("Pi selects, inputs and editors route values while named widgets and statuses update in place", async () => {
  const source = uiPort();
  const app = await mount(source.port);
  try {
    await app.change(() => {
      source.emit({ type: "extension_ui_request", id: "select", method: "select", title: "Pick a role", options: ["Builder", "Reviewer"] });
      source.emit({ type: "extension_ui_request", id: "input", method: "input", title: "Branch", placeholder: "feature/name" });
      source.emit({ type: "extension_ui_request", id: "editor", method: "editor", title: "Edit instructions", prefill: "Keep the first line.\nChange the second." });
      source.emit({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "mode", statusText: "Planning" });
      source.emit({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "plan", widgetLines: ["Plan above editor"] });
      source.emit({ type: "extension_ui_request", id: "below", method: "setWidget", widgetKey: "hint", widgetPlacement: "belowEditor", widgetLines: ["Hint below editor"] });
    });
    let frame = app.captureCharFrame();
    expect(frame).toContain("Builder");
    expect(frame).toContain("Planning");
    expect(frame).toContain("Plan above editor");
    expect(frame).toContain("Hint below editor");
    expect(await app.answer({ type: "dialog_response", id: "select", value: "Reviewer" })).toBe(true);
    expect(app.captureCharFrame()).toContain("feature/name");
    await app.answer({ type: "dialog_response", id: "input", value: "feature/menu" });
    expect(app.captureCharFrame()).toContain("Keep the first line.");
    await app.answer({ type: "dialog_response", id: "editor", value: "Reviewed\ninstructions" });
    expect(source.responses).toEqual([
      { type: "extension_ui_response", id: "select", value: "Reviewer" },
      { type: "extension_ui_response", id: "input", value: "feature/menu" },
      { type: "extension_ui_response", id: "editor", value: "Reviewed\ninstructions" },
    ]);
    await app.change(() => {
      source.emit({ type: "extension_ui_request", id: "status2", method: "setStatus", statusKey: "mode", statusText: "\x1b[32mBuilding\x1b[0m" });
      source.emit({ type: "extension_ui_request", id: "widget2", method: "setWidget", widgetKey: "plan", widgetLines: ["Updated plan"] });
      source.emit({ type: "extension_ui_request", id: "below2", method: "setWidget", widgetKey: "hint" });
    });
    frame = app.captureCharFrame();
    expect(frame).toContain("Building");
    expect(frame).toContain("Updated plan");
    expect(frame).not.toContain("Planning");
    expect(frame).not.toContain("Plan above editor");
    expect(frame).not.toContain("Hint below editor");
    await app.disconnect();
    expect(app.state().dialogs).toEqual([]);
    expect(app.state().statuses).toEqual([]);
    expect(app.state().widgets).toEqual([]);
    expect(app.captureCharFrame().trim()).toBe("");
  } finally {
    app.close();
  }
});

test("Pi dialog deadlines cancel their own question without removing later input", async () => {
  const source = uiPort();
  const app = await mount(source.port);
  try {
    await app.change(() => {
      source.emit({ type: "extension_ui_request", id: "timeout", method: "input", title: "Brief question", timeout: 30 });
      source.emit({ type: "extension_ui_request", id: "next", method: "input", title: "Next question" });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
    await app.renderOnce();
    expect(source.responses).toEqual([{ type: "extension_ui_response", id: "timeout", cancelled: true }]);
    expect(app.state().dialogs.map((dialog) => dialog.id)).toEqual(["next"]);
    expect(app.captureCharFrame()).toContain("Next question");
    await app.answer({ type: "dialog_response", id: "next", cancelled: true });
    expect(source.responses.at(-1)).toEqual({ type: "extension_ui_response", id: "next", cancelled: true });
  } finally {
    app.close();
  }
});
