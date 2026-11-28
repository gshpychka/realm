import { expect, test } from "bun:test";
import { dismiss, hintLine, MOVE, PAGE, position } from "./hints.ts";

test("a hint line names each key in one vocabulary, then where the list stands", () => {
  expect(hintLine([MOVE, ["enter", "pick"], dismiss("esc", "close")], position(1, 10), 80)).toBe(
    "↑↓ move · enter pick · esc close · 2 of 10",
  );
});

test("an unbound key drops out of the line", () => {
  expect(hintLine([MOVE, dismiss(null, "cancel")], null, 80)).toBe("↑↓ move");
});

test("a narrow line leaves out moving, then paging, keeping the dismissing key and the count", () => {
  expect(hintLine([MOVE, ["enter", "pick"], ["esc", "close"]], "3 of 12", 40)).toBe(
    "enter pick · esc close · 3 of 12",
  );
  const select = [MOVE, ["enter", "pick"], PAGE, dismiss("esc", "cancel")] as const;
  expect(hintLine(select, null, 50)).toBe("enter pick · pgup pgdn scroll · esc cancel");
  expect(hintLine(select, null, 40)).toBe("enter pick · esc cancel");
  // Only a line that still does not fit is cut at its end.
  expect(hintLine([MOVE, ["enter", "pick"], ["esc", "close"]], "2 of 2", 16)).toBe("enter pick · es…");
});
