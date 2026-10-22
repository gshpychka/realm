import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { createRef, useState } from "react";
import { CustomPanel } from "./components/custom-panel.tsx";
import { Dialog, GRACE_MS } from "./components/dialog.tsx";
import type { EditorHandle } from "./components/editor.tsx";
import { useHeldKeys } from "./use-held-keys.ts";

test("keys held behind an app action reach the input that now owns focus", async () => {
  let settled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let busy = true;
  const editor = createRef<EditorHandle>();
  editor.current = {
    busy: () => busy,
    settle: () => waiting,
  } as EditorHandle;
  let input = "";
  function Probe() {
    const [popup, setPopup] = useState(false);
    useHeldKeys(
      editor,
      (key) => {
        if (key.ctrl && key.name === "l") {
          key.preventDefault();
          flushSync(() => setPopup(true));
        }
      },
      !popup,
    );
    return popup ? (
      <input
        focused
        onInput={(text: string) => {
          input = text;
        }}
      />
    ) : null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await app.renderOnce();
    const control = parseKeypress("\x0c");
    const letter = parseKeypress("x");
    if (!control || !letter) throw new Error("test keys did not parse");
    app.renderer.keyInput.emit("keypress", new KeyEvent(control));
    app.renderer.keyInput.emit("keypress", new KeyEvent(letter));
    busy = false;
    settled();
    const deadline = Date.now() + 1000;
    while (!input && Date.now() < deadline) {
      await app.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(input).toBe("x");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

for (const kind of ["dialog", "component"] as const)
  test(`an Enter held for the draft cannot reach an extension ${kind} opened before release`, async () => {
    let settled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let busy = true;
    const editor = createRef<EditorHandle>();
    editor.current = { busy: () => busy, settle: () => waiting } as EditorHandle;
    let open = () => {};
    let answer: unknown;
    const keys: string[] = [];
    const dialog = {
      type: "extension_ui_request" as const,
      id: "permission",
      method: "select" as const,
      title: "Allow this command?",
      options: ["Yes", "No"],
    };
    const custom = { id: "component", lines: ["Extension component"] };
    function Probe() {
      const [popup, setPopup] = useState(false);
      open = () => setPopup(true);
      useHeldKeys(
        editor,
        (key) => {
          if (popup && kind === "component") {
            key.preventDefault();
            keys.push(key.sequence);
          }
        },
        !popup,
        popup ? (kind === "dialog" ? dialog : custom) : null,
      );
      return popup ? (
        kind === "dialog" ? (
          <Dialog
            dialog={dialog}
            behind={0}
            onAnswer={(response) => {
              answer = response;
            }}
          />
        ) : (
          <CustomPanel view={custom} rows={3} />
        )
      ) : (
        <input focused />
      );
    }
    const app = await createTestRenderer({ width: 60, height: 12 });
    const root = createRoot(app.renderer);
    try {
      flushSync(() => root.render(<Probe />));
      await app.renderOnce();
      const enter = parseKeypress("\r");
      if (!enter) throw new Error("Enter did not parse");
      app.renderer.keyInput.emit("keypress", new KeyEvent(enter));
      flushSync(open);
      await app.renderOnce();
      await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 50));
      await app.renderOnce();
      busy = false;
      settled();
      for (let frame = 0; frame < 10; frame++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await app.renderOnce();
      }
      expect(answer).toBeUndefined();
      expect(keys).toEqual([]);
      app.renderer.keyInput.emit("keypress", new KeyEvent(enter));
      if (kind === "dialog")
        expect(answer).toEqual({ type: "extension_ui_response", id: "permission", value: "Yes" });
      else expect(keys).toEqual(["\r"]);
    } finally {
      flushSync(() => root.unmount());
      app.renderer.destroy();
    }
  });
