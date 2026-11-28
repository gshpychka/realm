import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type { RunDetail } from "@realm/dura/types";
import { TaskResult } from "./team.tsx";

type Renderer = Awaited<ReturnType<typeof createTestRenderer>>;

/** Sends each sequence to the panel as the terminal would, and commits what it changes. */
function press(app: Renderer, ...sequences: string[]): void {
  for (const sequence of sequences) {
    const key = parseKeypress(sequence);
    if (!key) throw new Error("key did not parse");
    flushSync(() => app.renderer.keyInput.emit("keypress", new KeyEvent(key)));
  }
}

for (const stopped of [false, true])
  test(`accepted or stopped results retain evidence and block integration (${stopped ? "stopped" : "accepted"})`, async () => {
    const task = {
      id: "builder",
      role: "builder",
      status: stopped ? "complete" : "accepted",
      revision: 1,
      reportId: "report",
      artifactId: "code",
      integrationId: "merge",
      verificationId: "checks",
    };
    const detail = {
      run: { desired: stopped ? "stopped" : "running" },
      tasks: [task],
      attempts: [],
      questions: [],
      reports: [{ id: "report", text: "Retained report" }],
      artifacts: [{ id: "code", tree: "a".repeat(40), bytes: 1 }],
      integrations: [
        {
          id: "merge",
          status: stopped ? "conflicted" : "integrated",
          conflicts: ["unsafe\x1b[2Jpath"],
          error: null,
        },
      ],
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
      // An accepted task has nothing to retry.
      if (stopped) expect(frame).toContain("r retry");
      else expect(frame).not.toContain("r retry");
      await new Promise((resolve) => setTimeout(resolve, 450));
      press(app, "i", "\x03", "\x12", "\x1bi");
      expect(actions).toEqual([]);
      press(app, "c");
      expect(actions).toEqual(["copy"]);
      // A retry waits for the second press, and says what that press does meanwhile.
      press(app, "r");
      await app.renderOnce();
      expect(actions).toEqual(["copy"]);
      expect(app.captureCharFrame()).toContain(stopped ? "r again to start a fresh attempt" : "e revise");
      press(app, "r");
      expect(actions).toEqual(stopped ? ["copy", "retry"] : ["copy"]);
    } finally {
      flushSync(() => root.unmount());
      app.renderer.destroy();
    }
  });

test("applying to the operator's workspace waits for a second press, which any other key forgoes", async () => {
  const task = {
    id: "builder",
    role: "builder",
    status: "accepted",
    revision: 2,
    reportId: null,
    artifactId: "code",
    integrationId: "merge",
    verificationId: "checks",
  };
  const detail = {
    run: {
      desired: "running",
      cwd: "/work/workspace",
      acceptedArtifactId: "accepted",
      integrationArtifactId: "accepted",
    },
    tasks: [task],
    attempts: [],
    questions: [],
    reports: [],
    artifacts: [{ id: "code", tree: "b".repeat(40), bytes: 8192 }],
    integrations: [{ id: "merge", status: "integrated", conflicts: [], error: null }],
    verifications: [
      {
        id: "checks",
        status: "passed",
        tree: "b".repeat(40),
        artifactId: "accepted",
        revision: 2,
        integrationId: "merge",
        checks: [{ name: "types", status: "passed", output: "" }],
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
    expect(frame).toContain("result · builder · revision 2");
    expect(frame).toContain("8 KiB");
    expect(frame).toContain("✓ types");
    expect(frame).not.toContain("types · passed");
    expect(frame).toContain("a apply · e revise · esc back");
    await new Promise((resolve) => setTimeout(resolve, 450));
    press(app, "a");
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("a again to apply to /work/workspace");
    press(app, "x", "a");
    expect(actions).toEqual([]);
    press(app, "a");
    expect(actions).toEqual(["apply"]);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
