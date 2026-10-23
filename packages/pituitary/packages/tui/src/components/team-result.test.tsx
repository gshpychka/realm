import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type { RunDetail } from "@pituitary/harness/runtime";
import { TaskResult } from "./team.tsx";

test("accepted results retain verification and modified keys cannot run result actions", async () => {
  const task = {
    id: "builder",
    role: "builder",
    status: "accepted",
    revision: 1,
    reportId: "report",
    artifactId: "code",
    integrationId: "merge",
    verificationId: "checks",
  };
  const detail = {
    run: {},
    tasks: [task],
    attempts: [],
    questions: [],
    reports: [{ id: "report", text: "Retained report" }],
    artifacts: [{ id: "code", tree: "a".repeat(40), bytes: 1 }],
    integrations: [{ id: "merge", status: "integrated", conflicts: ["unsafe\x1b[2Jpath"], error: null }],
    verifications: [
      {
        id: "checks",
        status: "failed",
        tree: "a".repeat(40),
        checks: [{ name: "types", status: "failed", output: "missing export", truncated: true }],
      },
    ],
  } as unknown as RunDetail;
  const actions: string[] = [];
  const app = await createTestRenderer({ width: 80, height: 20 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() =>
      root.render(
        <TaskResult
          detail={detail}
          taskId="builder"
          rows={20}
          close={() => {}}
          integrate={() => actions.push("integrate")}
          retry={() => actions.push("retry")}
          revise={() => actions.push("revise")}
          apply={() => actions.push("apply")}
          copy={() => actions.push("copy")}
        />,
      ),
    );
    await app.renderOnce();
    const frame = app.captureCharFrame();
    expect(frame).toContain("missing export");
    expect(frame).toContain("output truncated");
    expect(frame).not.toContain("i integrate");
    expect(frame).not.toContain("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 450));
    for (const sequence of ["i", "\x03", "\x12", "\x1bi"]) {
      const key = parseKeypress(sequence);
      if (!key) throw new Error("key did not parse");
      app.renderer.keyInput.emit("keypress", new KeyEvent(key));
    }
    expect(actions).toEqual([]);
    const copy = parseKeypress("c");
    if (!copy) throw new Error("key did not parse");
    app.renderer.keyInput.emit("keypress", new KeyEvent(copy));
    expect(actions).toEqual(["copy"]);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
