import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { connectConversation } from "@pituitary/harness/conversation";
import { serveConversationFixture } from "../../harness/src/conversation.fixture.ts";
import { type SessionController, useSession } from "./use-session.ts";

async function until(done: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Native session did not update");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test("native atomic snapshots and paced events retain each reply once", async () => {
  const directory = mkdtempSync("/tmp/pituitary-session-view-");
  const host = await serveConversationFixture(
    directory,
    [{ id: "solo", currentAttemptId: "one", objective: "", role: null }],
    { local: true, scenario: "hello" },
  );
  const client = await connectConversation({
    socketPath: host.socketPath,
    runId: "run-team",
    taskId: "solo",
    control: true,
  });
  const app = await createTestRenderer({ width: 40, height: 8 }),
    root = createRoot(app.renderer);
  let session!: SessionController;
  function Probe() {
    session = useSession(client);
    return null;
  }
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => session.state !== null);
    expect(await session.send("first native reply")).toBe(true);
    await until(
      () =>
        !session.view.running &&
        session.view.entries.some(
          (entry) => entry.kind === "assistant" && entry.text === "You said: first native reply",
        ),
    );
    await session.refresh();
    expect(session.view.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(session.view.entries.find((entry) => entry.kind === "user")).toMatchObject({
      text: "first native reply",
    });
    await client.close();
    await until(() => session.closed !== null);
    expect(session.view.running).toBe(false);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
    await client.close();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
