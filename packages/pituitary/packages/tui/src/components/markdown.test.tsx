import { expect, spyOn, test } from "bun:test";
import { getTreeSitterClient } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { useState } from "react";
import { Markdown } from "./markdown.tsx";

const CONTENT = [
  "## Plan",
  "",
  "A **bold** paragraph with `code`.",
  "",
  "- first item",
  "- second item",
  "",
  "> quoted words",
  "",
  "```ts",
  "export const limit = 168;",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| limit | 168 |",
].join("\n");

test("settled markdown draws its structured text before asynchronous highlighting finishes", async () => {
  const parser = spyOn(getTreeSitterClient(), "highlightOnce").mockImplementation(
    () => new Promise(() => {}),
  );
  const app = await createTestRenderer({ width: 60, height: 24 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Markdown content={CONTENT} />));
    await app.renderOnce();
    const first = app.captureCharFrame();
    for (const text of [
      "Plan",
      "A bold paragraph with code.",
      "- first item",
      "- second item",
      "quoted words",
      "export const limit = 168;",
      "Name",
      "Value",
    ]) {
      expect(first).toContain(text);
    }
    expect(first).not.toMatch(/##|\*\*|```|> quoted/);
  } finally {
    root.unmount();
    app.renderer.destroy();
    parser.mockRestore();
  }
});

test("finalizing a streamed paragraph preserves its visible text while highlighting is pending", async () => {
  const parser = spyOn(getTreeSitterClient(), "highlightOnce").mockImplementation(
    () => new Promise(() => {}),
  );
  let finish = () => {};
  function Example() {
    const [streaming, setStreaming] = useState(true);
    finish = () => setStreaming(false);
    return <Markdown content="The **complete** reply." streaming={streaming} />;
  }
  const app = await createTestRenderer({ width: 60, height: 6 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Example />));
    await app.renderOnce();
    const before = app.captureCharFrame();
    expect(before).toContain("The complete reply.");
    flushSync(finish);
    await app.renderOnce();
    expect(app.captureCharFrame()).toBe(before);
  } finally {
    root.unmount();
    app.renderer.destroy();
    parser.mockRestore();
  }
});
