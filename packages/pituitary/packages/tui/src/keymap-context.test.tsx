import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { WorkBox } from "./components/work.tsx";
import { keymap } from "./keymap.ts";
import { KeyHint, KeymapProvider } from "./keymap-context.tsx";
import type { Work } from "./transcript.ts";

const work: Work = {
  kind: "work",
  id: "work",
  live: false,
  steps: [{ kind: "thinking", id: "thinking", text: "consider it" }],
};
for (const [binding, expected] of [
  ["alt+t", " · alt+t"],
  [[], ""],
] as const) {
  test(`an inline key hint follows ${typeof binding === "string" ? "a custom binding" : "an unbound action"}`, async () => {
    const app = await createTestRenderer({ width: 60, height: 12 });
    const root = createRoot(app.renderer);
    try {
      flushSync(() =>
        root.render(
          <KeymapProvider
            value={keymap({
              "app.thinking.toggle": binding,
              "app.tools.expand": typeof binding === "string" ? "alt+o" : [],
            })}
          >
            <box flexDirection="column">
              <WorkBox
                work={work}
                open
                whole={false}
                thinking={false}
                selected={false}
                rows={6}
                onToggle={() => {}}
                onResized={() => {}}
              />
              <text>
                more output
                <KeyHint action="app.tools.expand" />
              </text>
            </box>
          </KeymapProvider>,
        ),
      );
      await app.renderOnce();
      const frame = app.captureCharFrame();
      expect(frame).toContain(`thinking…${expected}`);
      expect(frame).toContain(`more output${expected ? " · alt+o" : ""}`);
      expect(frame).not.toMatch(/ctrl\+t|ctrl\+o/);
      if (!expected) expect(frame).not.toContain(" · ");
    } finally {
      flushSync(() => root.unmount());
      app.renderer.destroy();
    }
  });
}
