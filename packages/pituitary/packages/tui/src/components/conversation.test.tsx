import { expect, spyOn, test } from "bun:test";
import { getTreeSitterClient, type ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type { Entry } from "@pituitary/rpc";
import { act, createRef, useState } from "react";
import { Conversation } from "./conversation.tsx";

const WORDS = "Amber birch cedar dogwood elm fir ginkgo hazel ivy juniper";

test("a narrow reply includes every wrapped row beside its mark in its first frame", async () => {
  const parser = spyOn(getTreeSitterClient(), "highlightOnce").mockImplementation(
    () => new Promise(() => {}),
  );
  const entries: Entry[] = [
    { kind: "user", id: "question", text: WORDS },
    {
      kind: "assistant",
      id: "answer",
      text: `You said: ${WORDS}`,
      thinking: "",
      tools: [],
      done: true,
    },
  ];
  const app = await createTestRenderer({ width: 44, height: 28 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() =>
      root.render(
        <Conversation
          entries={entries}
          running={false}
          display={{ expanded: false, thinking: false, escapes: "esc esc" }}
          window={100}
          browsing={false}
          onLeave={() => {}}
          ref={createRef<ScrollBoxRenderable>()}
        />,
      ),
    );
    await app.renderOnce();
    const first = app.captureCharFrame();
    const lines = first.split("\n").map((line) => line.trimEnd());
    const row = lines.findIndex((line) => line.includes("You said:"));
    expect(lines[row]).toBe(" ● You said: Amber birch cedar dogwood elm");
    expect(lines[row + 1]).toBe("   fir ginkgo hazel ivy juniper");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
    parser.mockRestore();
  }
});

test("narrowing a long reply keeps its wrapped tail in view", async () => {
  const parser = spyOn(getTreeSitterClient(), "highlightOnce").mockImplementation(
    () => new Promise(() => {}),
  );
  const entries: Entry[] = [
    { kind: "user", id: "question", text: "go" },
    {
      kind: "assistant",
      id: "answer",
      text: Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the long answer`).join("\n"),
      thinking: "",
      tools: [],
      done: true,
    },
  ];
  const app = await createTestRenderer({ width: 44, height: 28 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() =>
      root.render(
        <Conversation
          entries={entries}
          running={false}
          display={{ expanded: false, thinking: false, escapes: "esc esc" }}
          window={100}
          browsing={false}
          onLeave={() => {}}
          ref={createRef<ScrollBoxRenderable>()}
        />,
      ),
    );
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("line 40 of the long answer");
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await act(async () => {
        app.resize(30, 28);
        await app.renderOnce();
        expect(app.captureCharFrame()).toContain("line 40 of the long");
      });
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }
    await app.renderOnce();
    const narrowed = app
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    expect(narrowed).toContain("   line 40 of the long\n   answer");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
    parser.mockRestore();
  }
});

test("a narrow streamed reply keeps its latest line visible through completion", async () => {
  const parser = spyOn(getTreeSitterClient(), "highlightOnce").mockImplementation(
    () => new Promise(() => {}),
  );
  let update = (_text: string, _done = false) => {};
  function Example() {
    const [reply, setReply] = useState({ text: "", done: false });
    update = (text, done = false) => setReply({ text, done });
    const entries: Entry[] = [
      { kind: "user", id: "question", text: "go" },
      { kind: "assistant", id: "answer", thinking: "", tools: [], ...reply },
    ];
    return (
      <Conversation
        entries={entries}
        running={!reply.done}
        display={{ expanded: false, thinking: false, escapes: "esc esc" }}
        window={100}
        browsing={false}
        onLeave={() => {}}
        ref={createRef<ScrollBoxRenderable>()}
      />
    );
  }
  const app = await createTestRenderer({ width: 30, height: 28 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Example />));
    await app.renderOnce();
    const lines: string[] = [];
    for (let line = 1; line <= 40; line++) {
      lines.push(`line ${line} of the long answer`);
      flushSync(() => update(lines.join("\n")));
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain(`line ${line} of the long`);
    }
    flushSync(() => update(lines.join("\n"), true));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("line 40 of the long");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("line 40 of the long");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
    parser.mockRestore();
  }
});

test("loading earlier history moves back one page while keeping the reading position", async () => {
  const entries: Entry[] = Array.from({ length: 200 }, (_, index) => ({
    kind: "user",
    id: `prompt-${index + 1}`,
    text: `prompt ${index + 1}`,
  }));
  const scroll = createRef<ScrollBoxRenderable>();
  let more = () => {};
  let load = () => {};
  function Example() {
    const [window, setWindow] = useState(50);
    const [active, setActive] = useState(false);
    more = () => setWindow(100);
    load = () => setActive(true);
    return (
      <Conversation
        entries={active ? entries : []}
        running={false}
        display={{ expanded: false, thinking: false, escapes: "esc" }}
        window={window}
        browsing={false}
        onLeave={() => {}}
        ref={scroll}
      />
    );
  }
  const app = await createTestRenderer({ width: 60, height: 14 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Example />));
    await app.renderOnce();
    flushSync(load);
    await app.renderOnce();
    scroll.current?.scrollTo(0);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("prompt 151");
    flushSync(more);
    await app.renderOnce();
    const frame = app.captureCharFrame();
    expect(frame).toContain("prompt 150");
    expect(frame).toContain("prompt 151");
    expect(frame).not.toContain("prompt 101");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("a history prepend with unchanged geometry cannot anchor a later resize", async () => {
  const entries: Entry[] = Array.from({ length: 100 }, (_, index) => ({
    kind: "assistant",
    id: `work-${index}`,
    text: "",
    thinking: "consider it",
    tools: [],
    done: true,
  }));
  const scroll = createRef<ScrollBoxRenderable>();
  let more = () => {};
  let expand = () => {};
  function Example() {
    const [window, setWindow] = useState(50);
    const [expanded, setExpanded] = useState(false);
    more = () => setWindow(60);
    expand = () => setExpanded(true);
    return (
      <Conversation
        entries={entries}
        running={false}
        display={{ expanded, thinking: true, escapes: "esc" }}
        window={window}
        browsing={false}
        onLeave={() => {}}
        ref={scroll}
      />
    );
  }
  const app = await createTestRenderer({ width: 60, height: 14 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Example />));
    await app.renderOnce();
    flushSync(more);
    await app.renderOnce();
    flushSync(expand);
    await app.renderOnce();
    const box = scroll.current;
    if (!box) throw new Error("missing scrollbox");
    expect(box.scrollTop).toBe(Math.max(0, box.scrollHeight - box.height));
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
