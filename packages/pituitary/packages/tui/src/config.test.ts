import { expect, test } from "bun:test";
import { attachCommand } from "./config.ts";

test("reconnect commands preserve run identity and custom state with shell quoting", () => {
  expect(attachCommand("builder", "/tmp/my 'private' state")).toContain("--state");
  expect(attachCommand("builder")).toBe("pituitary attach builder");
});
