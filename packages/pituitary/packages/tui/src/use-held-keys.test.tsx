import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { createRef, useState } from "react";
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
      async (key) => {
        if (key.ctrl && key.name === "l") {
          key.preventDefault();
          await new Promise((resolve) => setTimeout(resolve, 30));
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

test("an Enter held for the draft cannot answer a newly opened operator dialog", async () => {
  let settled!: () => void;
  const waiting = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let busy = true;
  const editor = createRef<EditorHandle>();
  editor.current = { busy: () => busy, settle: () => waiting } as EditorHandle;
  let open = () => {};
  let answer: unknown;
  const dialog = {
    type: "extension_ui_request" as const,
    id: "question",
    method: "select" as const,
    title: "Where should focus return?",
    options: ["Trigger", "Next item"],
  };
  function Probe() {
    const [popup, setPopup] = useState(false);
    open = () => setPopup(true);
    useHeldKeys(editor, () => {}, !popup, popup ? dialog : null);
    return popup ? (
      <Dialog
        dialog={dialog}
        behind={0}
        onAnswer={(value) => {
          answer = value;
        }}
      />
    ) : (
      <input focused />
    );
  }
  const app = await createTestRenderer({ width: 60, height: 12 }),
    root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await app.renderOnce();
    const enter = parseKeypress("\r");
    if (!enter) throw new Error("Enter did not parse");
    app.renderer.keyInput.emit("keypress", new KeyEvent(enter));
    flushSync(open);
    await app.renderOnce();
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS + 50));
    busy = false;
    settled();
    for (let frame = 0; frame < 10; frame++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await app.renderOnce();
    }
    expect(answer).toBeUndefined();
    app.renderer.keyInput.emit("keypress", new KeyEvent(enter));
    expect(answer).toEqual({ type: "extension_ui_response", id: "question", value: "Trigger" });
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
