import { expect, test } from "bun:test";
import { dismiss, hintLine, MOVE, position } from "./hints.ts";

test("a hint line names each key in one vocabulary, then where the list stands", () => {
  expect(hintLine([MOVE, ["enter", "pick"], dismiss("esc", "close")], position(1, 10), 80)).toBe(
    "↑↓ move · enter pick · esc close · 2 of 10",
  );
});

test("an unbound key drops out of the line, and a narrow line is cut at its end", () => {
  expect(hintLine([MOVE, dismiss(null, "cancel")], null, 80)).toBe("↑↓ move");
  expect(hintLine([MOVE, ["enter", "pick"], ["esc", "close"]], "2 of 2", 16)).toBe("↑↓ move · enter…");
});
