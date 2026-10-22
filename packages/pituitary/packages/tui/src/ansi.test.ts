import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { parseAnsi } from "./ansi.ts";
import { palette } from "./theme.ts";

describe("parseAnsi", () => {
  test("truecolour foregrounds split the row into runs", () => {
    expect(parseAnsi("\x1b[38;2;138;190;183m→ vanilla\x1b[39m plain")).toEqual([
      { text: "→ vanilla", fg: "#8abeb7", attributes: 0 },
      { text: " plain", attributes: 0 },
    ]);
  });

  test("basic and 256-colour codes map to colours", () => {
    expect(parseAnsi("\x1b[31mred\x1b[0m")[0]?.fg).toBe(palette.red);
    expect(parseAnsi("\x1b[48;5;196mhot")[0]?.bg).toBe("#ff0000");
    expect(parseAnsi("\x1b[38;5;244mgrey")[0]?.fg).toBe("#808080");
  });

  test("attributes turn on and off", () => {
    const runs = parseAnsi("\x1b[1mbold\x1b[22m plain \x1b[3;4mboth");
    expect(runs.map((run) => run.attributes)).toEqual([
      TextAttributes.BOLD,
      0,
      TextAttributes.ITALIC | TextAttributes.UNDERLINE,
    ]);
  });

  test("hyperlinks, cursor markers, and cursor movement leave only their text", () => {
    const line = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b_pi:c\x07here\x1b[2K\x1b[1G!";
    expect(
      parseAnsi(line)
        .map((run) => run.text)
        .join(""),
    ).toBe("link here!");
  });

  test("a tab takes the three cells pi's components measured it as", () => {
    expect(parseAnsi("a\tb")).toEqual([{ text: "a   b", attributes: 0 }]);
  });

  test("a row with no escapes is one run", () => {
    expect(parseAnsi("plain text")).toEqual([{ text: "plain text", attributes: 0 }]);
    expect(parseAnsi("")).toEqual([]);
  });
});
