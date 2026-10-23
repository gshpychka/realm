import { mkdtempSync, rmSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot, extend } from "@opentui/react";
import { connectConversation } from "@realm/dura/client";
import { serveConversationFixture } from "../../../../dura/src/conversation.fixture.ts";
import { App } from "./app.tsx";
import { OptInText } from "./components/text.ts";
import { prewarm } from "./nvim/engine.ts";
import * as profile from "./profile.ts";

profile.mark("modules");
const directory = mkdtempSync("/tmp/pituitary-ui-fixture-");
const local = process.env.PITUITARY_FIXTURE_REMOTE !== "1";
const archived = process.env.PITUITARY_FIXTURE_ARCHIVED === "1";
const cwd = local ? process.cwd() : "/work/workspace";
const server = await serveConversationFixture(
  directory,
  [{ id: "solo", currentAttemptId: "attempt", objective: "", role: local ? null : "builder" }],
  {
    local,
    cwd: process.cwd(),
    scenario: process.env.PITUITARY_FIXTURE_SCENARIO ?? "hello",
    delayMs: Number(process.env.PITUITARY_FIXTURE_DELAY ?? 0),
    archived,
    model: process.env.PITUITARY_FIXTURE_MODEL !== "none",
  },
);
const client = await connectConversation({
  socketPath: server.socketPath,
  runId: "run-team",
  taskId: "solo",
  control: !archived,
});
profile.mark("agent-spawned");
prewarm();
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 120, maxFps: 120 });
profile.mark("renderer");
extend({ text: OptInText });
const root = createRoot(renderer);
renderer.once("frame", () => profile.mark("first-frame"));
let closing = false;
const quit = () => {
  if (closing) return;
  closing = true;
  profile.mark("quit");
  root.unmount();
  profile.mark("ui-unmounted");
  renderer.destroy();
  profile.mark("renderer-destroyed");
  void client
    .close()
    .then(() => server.close())
    .then(() => {
      profile.mark("agent-closed");
      rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    });
};
process.once("SIGTERM", quit);
process.once("exit", () => profile.mark("exit"));
root.render(
  <App
    link={client}
    workspace={{
      cwd,
      local: local && process.env.PITUITARY_REMOTE_UI !== "1",
      modelSelectable: local,
      label: !local ? "builder" : process.env.PITUITARY_REMOTE_UI === "1" ? "remote" : undefined,
      access: archived ? "archive" : "control",
    }}
    onQuit={quit}
  />,
);
