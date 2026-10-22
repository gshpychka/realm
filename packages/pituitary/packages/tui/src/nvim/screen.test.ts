import { describe, expect, test } from "bun:test";
import { type Frame, Screen } from "./screen.ts";

const BOLD = 1;
const PAST = 2;

/** A screen `width` cells by `height` rows, a bold highlight and the rows past the buffer's end defined. */
function screenOf(width: number, height: number): Screen {
  const screen = new Screen();
  screen.apply([
    ["grid_resize", [1, width, height]],
    [
      "hl_attr_define",
      [BOLD, { bold: true }, {}, []],
      [PAST, {}, {}, [{ kind: "ui", ui_name: "EndOfBuffer" }]],
    ],
    [
      "mode_info_set",
      [
        true,
        [
          { name: "normal", cursor_shape: "block" },
          { name: "insert", cursor_shape: "vertical" },
        ],
      ],
    ],
  ]);
  return screen;
}

/** Applies `events` as one batch that ends in a flush. */
function draw(screen: Screen, ...events: unknown[][]): Frame {
  const frame = screen.apply([...events, ["flush", []]]);
  if (!frame) throw new Error("a flush completed no frame");
  return frame;
}

/** A `grid_line` event writing `text` from the start of `row`, a cell to a character. */
const line = (row: number, text: string, id = 0) => [
  "grid_line",
  [1, row, 0, [...text].map((char) => [char, id]), false],
];

/** Each row's text, its runs joined. */
const textOf = (frame: Frame) => frame.rows.map((row) => row.map((run) => run.text).join(""));

describe("nvim's screen", () => {
  test("a line's cells keep the highlight before them and repeat as many times as they say", () => {
    const frame = draw(screenOf(6, 1), ["grid_line", [1, 0, 0, [["a", BOLD], ["b"], [" ", 0, 4]], false]]);
    expect(frame.rows).toEqual([
      [
        { text: "ab", highlight: { bold: true } },
        { text: "    ", highlight: {} },
      ],
    ]);
  });

  test("nothing shows until a batch ends in a flush", () => {
    const screen = screenOf(3, 1);
    expect(screen.apply([line(0, "xyz")])).toBeNull();
    expect(textOf(draw(screen))).toEqual(["xyz"]);
  });

  test("a wide character's right half adds nothing to the row's text", () => {
    const frame = draw(screenOf(4, 1), ["grid_line", [1, 0, 0, [["😀", 0], [""], ["x"], [" "]], false]]);
    expect(textOf(frame)).toEqual(["😀x "]);
  });

  test("rows past the end of the buffer are left out, save the one the cursor is on", () => {
    const screen = screenOf(3, 4);
    screen.apply([line(0, "abc"), line(1, "   ", PAST), line(2, "   ", PAST)]);
    expect(draw(screen, ["grid_cursor_goto", [1, 0, 0]]).rows).toHaveLength(1);
    expect(draw(screen, ["grid_cursor_goto", [1, 1, 0]]).rows).toHaveLength(2);
  });

  test("a scroll moves the region's rows up or down, and leaves the rest", () => {
    const screen = screenOf(1, 4);
    const rows = [line(0, "0"), line(1, "1"), line(2, "2"), line(3, "3")];
    screen.apply(rows);
    expect(textOf(draw(screen, ["grid_scroll", [1, 0, 3, 0, 1, 1, 0]]))).toEqual(["1", "2", "2", "3"]);
    screen.apply(rows);
    expect(textOf(draw(screen, ["grid_scroll", [1, 1, 4, 0, 1, -2, 0]]))).toEqual(["0", "1", "2", "1"]);
  });

  test("a resize keeps the cells that still fit, and a clear blanks every cell", () => {
    const screen = screenOf(3, 2);
    screen.apply([line(0, "abc"), line(1, "def")]);
    expect(textOf(draw(screen, ["grid_resize", [1, 2, 1]]))).toEqual(["ab"]);
    expect(textOf(draw(screen, ["grid_clear", [1]]))).toEqual(["  "]);
  });

  test("the mode names the cursor's shape, and busy hides the cursor", () => {
    const screen = screenOf(3, 1);
    const insert = draw(screen, ["mode_change", ["insert", 1]], ["grid_cursor_goto", [1, 0, 2]]);
    expect(insert.mode).toEqual({ name: "insert", cursor: "vertical", blinking: false });
    expect(insert.cursor).toEqual({ row: 0, col: 2 });
    expect(draw(screen, ["busy_start", []]).cursor).toBeNull();
    expect(draw(screen, ["busy_stop", []]).cursor).toEqual({ row: 0, col: 2 });
  });

  test("the command line shows its prompt and text, its cursor counted in cells from a byte offset", () => {
    const screen = screenOf(10, 1);
    const shown = draw(screen, ["cmdline_show", [[[{}, "s/é😀\x16"]], 4, ":", "", 0, 1, 0]]);
    expect(shown.cmdline).toEqual({ text: ":s/é😀^V", cursor: 4 });
    expect(draw(screen, ["cmdline_pos", [8, 1]]).cmdline?.cursor).toBe(6);
    expect(draw(screen, ["cmdline_hide", [1, false]]).cmdline).toBeNull();
  });

  test("default colours of -1 are left to the terminal, and events the screen does not keep change nothing", () => {
    const frame = draw(
      screenOf(1, 1),
      ["default_colors_set", [0xebdbb2, -1, -1, -1, -1]],
      ["msg_show", ["emsg", [], false, true, false, 1, ""]],
      ["toString", []],
    );
    expect(frame.colors).toEqual({ foreground: 0xebdbb2, background: undefined });
  });
});
