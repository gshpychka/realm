import { expect, test } from "bun:test";
import { ellipsize, headCells, tailCells, wrapCells } from "./text-width.ts";

test("clipping preserves wide and composed graphemes without skipping over them", () => {
  expect(headCells("a資料z", 4)).toBe("a資");
  expect(tailCells("z資料a", 4)).toBe("料a");
  expect(headCells("e\u0301👩‍💻x", 3)).toBe("e\u0301👩‍💻");
  expect(tailCells("x👩‍💻e\u0301", 3)).toBe("👩‍💻e\u0301");
  expect(ellipsize("e\u0301👩‍💻資料", 4)).toBe("e\u0301👩‍💻…");
  expect(headCells("資料", 0)).toBe("");
  expect(tailCells("資料", -2)).toBe("");
  expect(ellipsize("資料", 1)).toBe("…");
});

test("clipping measures the accumulated regional-indicator sequences", () => {
  for (const clip of [headCells, tailCells, ellipsize]) {
    for (let width = 0; width <= 8; width++) {
      expect(Bun.stringWidth(clip("🇺🇦a🇺🇦b🇺🇦", width))).toBeLessThanOrEqual(width);
    }
  }
});

test("wrapping breaks at spaces and cuts what is left at the end of the last row", () => {
  expect(wrapCells("builder · Build keyboard navigation and focus handling", 20, 2)).toEqual([
    "builder · Build",
    "keyboard navigation…",
  ]);
  expect(wrapCells("short", 20, 2)).toEqual(["short"]);
  expect(wrapCells("averyveryverylongword and more", 10, 3)).toEqual([
    "averyveryv",
    "erylongwor",
    "d and more",
  ]);
  for (let width = 1; width <= 12; width++)
    for (const row of wrapCells("a資料 bb 🇺🇦c dd", width, 3))
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
});
