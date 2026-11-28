import { expect, test } from "bun:test";
import { dismiss, hintLine, MOVE, PAGE, PICK, position } from "./hints.ts";

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
});

test("a line that still does not fit drops keys from its end, whole, and keeps the count", () => {
  const resume = [
    MOVE,
    PICK,
    ["ctrl+r", "rename"],
    ["ctrl+x", "delete"],
    ["tab", "every project"],
    ["esc", "close"],
  ] as const;
  expect(hintLine(resume, "2 of 2", 70)).toBe(
    "ctrl+r rename · ctrl+x delete · tab every project · esc close · 2 of 2",
  );
  expect(hintLine(resume, "2 of 2", 60)).toBe("ctrl+r rename · ctrl+x delete · tab every project · 2 of 2");
  expect(hintLine(resume, "2 of 2", 40)).toBe("ctrl+r rename · ctrl+x delete · 2 of 2");
  // Only a first key too long alone is cut, at its end.
  expect(hintLine(resume, "2 of 2", 20)).toBe("ctrl+r ren… · 2 of 2");
  expect(
    hintLine(
      [
        ["alt+u", "close"],
        ["/usage refresh", "updates"],
      ],
      null,
      30,
    ),
  ).toBe("alt+u close");
});
