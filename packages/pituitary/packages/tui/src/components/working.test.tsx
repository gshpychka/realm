import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { emptySession } from "@pituitary/session";
import { reconnectHint, resumeCommand } from "../working.ts";
import { Working } from "./working.tsx";

test("a lost agent's resume command stays whole, wrapping rather than cut, from another project", async () => {
  const id = "0195f3e2-7c1d-7000-8000-000000000000";
  const hint = reconnectHint(null, resumeCommand(id, "/home/user/projects/realm", "/home/user"));
  const app = await createTestRenderer({ width: 80, height: 6 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() =>
      root.render(<Working view={emptySession} hint={hint} closed="exited" escapes="" agent="pi" />),
    );
    await app.renderOnce();
    const rows = app
      .captureCharFrame()
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean);
    expect(rows).toEqual(["Disconnected · run cd /home/user/projects/realm && pituitary --session", id]);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});
