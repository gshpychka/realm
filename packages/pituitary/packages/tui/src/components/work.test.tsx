import { expect, spyOn, test } from "bun:test";
import { getTreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { useState } from "react";
import type { Work } from "../transcript.ts";
import { WorkBox } from "./work.tsx";

for (const whole of [true, false]) {
  test(`narration stays visible in the first ${whole ? "expanded" : "bounded"} work frame and on settling`, async () => {
    // These words already drew as a reply before its tool call moved them here.
    // The new markdown parser must not erase them while it works asynchronously.
    const parser = spyOn(getTreeSitterClient(), "highlightOnce").mockImplementation(
      () => new Promise(() => {}),
    );
    let settle = () => {};
    function Example() {
      const [live, setLive] = useState(true);
      settle = () => setLive(false);
      const work: Work = {
        kind: "work",
        id: "answer:text",
        live,
        steps: [{ kind: "text", id: "answer:text", text: "Checking **the build**." }],
      };
      return (
        <WorkBox
          work={work}
          open
          whole={whole}
          thinking
          selected={false}
          rows={6}
          onToggle={() => {}}
          onResized={() => {}}
        />
      );
    }
    const app = await createTestRenderer({ width: 60, height: 12 });
    const root = createRoot(app.renderer);
    try {
      flushSync(() => root.render(<Example />));
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("Checking the build.");
      expect(app.captureCharFrame()).not.toContain("**");
      flushSync(settle);
      await app.renderOnce();
      expect(app.captureCharFrame()).toContain("Checking the build.");
    } finally {
      root.unmount();
      app.renderer.destroy();
      parser.mockRestore();
    }
  });
}

test("a short open work box takes only the rows its steps need", async () => {
  const app = await createTestRenderer({ width: 60, height: 30 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() =>
      root.render(
        <WorkBox
          work={{
            kind: "work",
            id: "thought",
            live: false,
            steps: [{ kind: "thinking", id: "thought", text: "Consider the bound." }],
          }}
          open
          whole={false}
          thinking
          selected={false}
          rows={10}
          onToggle={() => {}}
          onResized={() => {}}
        />,
      ),
    );
    await app.renderOnce();
    const rows = app.captureCharFrame().split("\n");
    expect(rows.findIndex((line) => line.includes("╰")) - rows.findIndex((line) => line.includes("╭"))).toBe(
      2,
    );
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("a live work box grows to its cap and follows new steps without leaving blank rows", async () => {
  let update = (_text: string) => {};
  function Example() {
    const [text, setText] = useState("step 1");
    update = setText;
    return (
      <WorkBox
        work={{ kind: "work", id: "thought", live: true, steps: [{ kind: "thinking", id: "thought", text }] }}
        open
        whole={false}
        thinking
        selected={false}
        rows={6}
        onToggle={() => {}}
        onResized={() => {}}
      />
    );
  }
  const app = await createTestRenderer({ width: 60, height: 30 });
  const root = createRoot(app.renderer);
  const height = () => {
    const rows = app.captureCharFrame().split("\n");
    return rows.findIndex((line) => line.includes("╰")) - rows.findIndex((line) => line.includes("╭"));
  };
  try {
    flushSync(() => root.render(<Example />));
    await app.renderOnce();
    expect(height()).toBe(2);
    flushSync(() => update(Array.from({ length: 12 }, (_, index) => `step ${index + 1}`).join("\n")));
    await app.renderOnce();
    expect(height()).toBe(7);
    expect(app.captureCharFrame()).toContain("step 12");
    flushSync(() => update("step 1"));
    await app.renderOnce();
    expect(height()).toBe(2);
    expect(app.captureCharFrame()).toContain("step 1");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
