import { describe, expect, test } from "bun:test";
import { trimmed } from "./nvim-screen.tsx";

const SELECTION = 0x665c54;

describe("a screen row's runs", () => {
  test("lose the blanks at the row's end that draw nothing", () => {
    expect(trimmed([{ text: "draft   ", highlight: {} }], {})).toEqual([{ text: "draft", highlight: {} }]);
    expect(trimmed([{ text: "    ", highlight: {} }], {})).toEqual([]);
  });

  test("keep blanks that draw a colour or a line, and everything before them", () => {
    const runs = [
      { text: "ab ", highlight: {} },
      { text: "  ", highlight: { background: SELECTION } },
      { text: "   ", highlight: {} },
    ];
    expect(trimmed(runs, {})).toEqual(runs.slice(0, 2));
    expect(trimmed([{ text: "a  ", highlight: { underline: true } }], {})).toHaveLength(1);
    expect(trimmed([{ text: "a  ", highlight: {} }], { background: SELECTION })).toEqual([
      { text: "a  ", highlight: {} },
    ]);
  });
});
