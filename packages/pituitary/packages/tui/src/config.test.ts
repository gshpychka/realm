import { expect, test } from "bun:test";
import { attachCommand } from "./config.ts";

test("reconnect commands preserve run identity and custom state with shell quoting", () => {
  expect(attachCommand("builder", { stateDirectory: "/tmp/my 'private' state" })).toContain("--state");
  expect(attachCommand("builder")).toBe("pituitary attach builder");
});

test("reconnect commands preserve and quote a tunneled runtime socket", () => {
  expect(
    attachCommand("review run", {
      stateDirectory: "/tmp/state",
      taskId: "task",
      socketPath: "/tmp/my tunnel.sock",
    }),
  ).toBe("pituitary attach 'review run' --state /tmp/state --task task --socket '/tmp/my tunnel.sock'");
});
