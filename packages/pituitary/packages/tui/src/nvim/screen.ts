/**
 * nvim's screen, kept from the events its UI protocol sends: `:help ui-linegrid`, with the
 * `ext_hlstate` and `ext_cmdline` extensions. Without `ext_multigrid` it all draws on one grid.
 */

/** A highlight's attributes as `hl_attr_define` gives them; colours are 24-bit RGB. */
export interface Highlight {
  foreground?: number;
  background?: number;
  reverse?: boolean;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  blink?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  undercurl?: boolean;
  underdouble?: boolean;
  underdotted?: boolean;
  underdashed?: boolean;
}

/** Text along a screen row in one highlight. */
export interface Run {
  text: string;
  highlight: Highlight;
}

/** How the cursor is drawn, as 'guicursor' sets it. */
export type CursorForm = "block" | "horizontal" | "vertical";

/** A mode and the cursor 'guicursor' gives it: `:help mode_info_set`. */
export interface Mode {
  /** nvim's name for the mode, such as `normal`, `insert`, `visual`, or `replace`. */
  name: string;
  cursor: CursorForm;
  blinking: boolean;
}

/** The screen as a completed redraw leaves it. */
export interface Frame {
  /** The rows that show the buffer, top first. Rows past its end are left out, save one the cursor is on. */
  rows: Run[][];
  /** The cursor's row and cell, or null while nvim has it hidden. */
  cursor: { row: number; col: number } | null;
  mode: Mode;
  /** The command line while one is open: its text and the cell its cursor is on. */
  cmdline: { text: string; cursor: number } | null;
  /** Colours for highlights that leave theirs out; an absent one is the terminal's own. */
  colors: { foreground?: number; background?: number };
}

/** A `grid_line` cell: its text, then its highlight and how many cells repeat it, when they change. */
type LineCell = [text: string, id?: number, repeat?: number];

/** One item of `hl_attr_define`'s semantic description: `:help ui-hlstate`. */
interface HighlightInfo {
  kind: string;
  ui_name?: string;
}

/** One mode of `mode_info_set`, by the protocol's field names. */
interface ModeInfo {
  name: string;
  cursor_shape?: CursorForm;
  blinkon?: number;
  blinkoff?: number;
}

/** The events the screen keeps, by their arguments: `:help ui-events`. */
interface Events {
  grid_resize: [grid: number, width: number, height: number];
  grid_clear: [grid: number];
  grid_line: [grid: number, row: number, col: number, cells: LineCell[]];
  grid_scroll: [grid: number, top: number, bot: number, left: number, right: number, rows: number];
  grid_cursor_goto: [grid: number, row: number, col: number];
  hl_attr_define: [id: number, rgb: Highlight, cterm: Highlight, info: HighlightInfo[]];
  default_colors_set: [rgbFg: number, rgbBg: number];
  mode_info_set: [enabled: boolean, modes: ModeInfo[]];
  mode_change: [mode: string, index: number];
  busy_start: [];
  busy_stop: [];
  cmdline_show: [
    content: [id: number, text: string][],
    pos: number,
    firstc: string,
    prompt: string,
    indent: number,
  ];
  cmdline_pos: [pos: number];
  cmdline_hide: [];
  flush: [];
}

interface Cell {
  readonly text: string;
  readonly id: number;
}

const BLANK: Cell = { text: " ", id: 0 };

/** The rows and columns `grid_scroll` moves. */
interface Region {
  top: number;
  bot: number;
  left: number;
  right: number;
}

/** The cells of the grid, each with the highlight it draws in. */
class Grid {
  private cells: Cell[][] = [];

  get rows(): readonly (readonly Cell[])[] {
    return this.cells;
  }

  /** Keeps what fits of the cells at the new size; the rest starts blank. */
  resize(width: number, height: number): void {
    this.cells = Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, col) => this.cells[row]?.[col] ?? BLANK),
    );
  }

  clear(): void {
    this.cells = this.cells.map((row) => row.map(() => BLANK));
  }

  line(row: number, col: number, cells: LineCell[]): void {
    const target = this.cells[row];
    if (!target) return;
    let id = 0;
    let at = col;
    for (const [text, next, repeat = 1] of cells) {
      if (next !== undefined) id = next;
      const cell = { text, id };
      for (let count = 0; count < repeat && at < target.length; count++) target[at++] = cell;
    }
  }

  /** Moves the region's rows up by `rows`, or down when it is negative; nvim redraws the rows they leave. */
  scroll({ top, bot, left, right }: Region, rows: number): void {
    const copy = (row: number) => {
      const to = this.cells[row];
      const from = this.cells[row + rows];
      if (to && from) for (let col = left; col < right; col++) to[col] = from[col] ?? BLANK;
    };
    if (rows > 0) for (let row = top; row < bot - rows; row++) copy(row);
    else for (let row = bot - 1; row >= top - rows; row--) copy(row);
  }
}

interface Defined {
  highlight: Highlight;
  /** Drawn on the rows past the end of the buffer, which `EndOfBuffer` names whatever its colours. */
  past: boolean;
}

export class Screen {
  private readonly grid = new Grid();
  private cursor = { row: 0, col: 0 };
  private busy = false;
  private colors: Frame["colors"] = {};
  /** Id 0 is the default highlight, which nvim never defines. */
  private readonly highlights = new Map<number, Defined>([[0, { highlight: {}, past: false }]]);
  private modes: Mode[] = [];
  private mode: Mode = { name: "normal", cursor: "block", blinking: false };
  /** `pos` counts bytes of `content`'s UTF-8. */
  private cmdline: { lead: string; content: string; pos: number } | null = null;
  private flushed = false;

  /**
   * Applies the events of one `redraw` notification. A batch that ends in `flush` completes a
   * redraw and returns the frame it leaves; until then what the grid holds is not for showing.
   */
  apply(batch: readonly unknown[]): Frame | null {
    this.flushed = false;
    // Each event is its name, then the arguments of each call to it.
    for (const [name, ...calls] of batch as [string, ...unknown[]][]) {
      // The protocol grows new events, and extensions not asked for send others; none of them changes the draft.
      if (!Object.hasOwn(this.events, name)) continue;
      const handle = this.events[name as keyof Events] as (args: unknown) => void;
      for (const args of calls) handle(args);
    }
    return this.flushed ? this.frame() : null;
  }

  private readonly events: { [Name in keyof Events]: (args: Events[Name]) => void } = {
    grid_resize: ([, width, height]) => this.grid.resize(width, height),
    grid_clear: () => this.grid.clear(),
    grid_line: ([, row, col, cells]) => this.grid.line(row, col, cells),
    grid_scroll: ([, top, bot, left, right, rows]) => this.grid.scroll({ top, bot, left, right }, rows),
    grid_cursor_goto: ([, row, col]) => {
      this.cursor = { row, col };
    },
    hl_attr_define: ([id, highlight, , info]) => {
      const past = info.some((item) => item.kind === "ui" && item.ui_name === "EndOfBuffer");
      this.highlights.set(id, { highlight, past });
    },
    default_colors_set: ([foreground, background]) => {
      // With ext_termcolors, -1 leaves a colour to the terminal.
      const color = (rgb: number) => (rgb < 0 ? undefined : rgb);
      this.colors = { foreground: color(foreground), background: color(background) };
    },
    mode_info_set: ([, modes]) => {
      this.modes = modes.map((info) => ({
        name: info.name,
        cursor: info.cursor_shape ?? "block",
        blinking: (info.blinkon ?? 0) > 0 && (info.blinkoff ?? 0) > 0,
      }));
    },
    mode_change: ([name, index]) => {
      this.mode = this.modes[index] ?? { ...this.mode, name };
    },
    busy_start: () => {
      this.busy = true;
    },
    busy_stop: () => {
      this.busy = false;
    },
    cmdline_show: ([content, pos, firstc, prompt, indent]) => {
      const text = content.map(([, chunk]) => chunk).join("");
      this.cmdline = { lead: `${firstc}${prompt}${" ".repeat(indent)}`, content: text, pos };
    },
    cmdline_pos: ([pos]) => {
      if (this.cmdline) this.cmdline = { ...this.cmdline, pos };
    },
    cmdline_hide: () => {
      this.cmdline = null;
    },
    flush: () => {
      this.flushed = true;
    },
  };

  private frame(): Frame {
    const rows = this.grid.rows;
    const past = rows.findIndex((row) => this.highlights.get(row[0]?.id ?? 0)?.past);
    const shown = Math.max(past < 0 ? rows.length : past, this.cursor.row + 1);
    const { cmdline } = this;
    return {
      rows: rows.slice(0, shown).map((row) => this.runs(row)),
      cursor: this.busy ? null : { ...this.cursor },
      mode: this.mode,
      cmdline: cmdline && {
        text: printable(cmdline.lead + cmdline.content),
        cursor: Bun.stringWidth(printable(cmdline.lead + bytes(cmdline.content, cmdline.pos))),
      },
      colors: this.colors,
    };
  }

  private runs(row: readonly Cell[]): Run[] {
    const runs: Run[] = [];
    let run: Run | null = null;
    let id = -1;
    for (const cell of row) {
      if (!run || cell.id !== id) {
        id = cell.id;
        run = { text: "", highlight: this.highlights.get(id)?.highlight ?? {} };
        runs.push(run);
      }
      // The right half of a wide character is an empty cell.
      run.text += cell.text;
    }
    return runs;
  }
}

/** The first `count` bytes of `text`'s UTF-8, as text. */
function bytes(text: string, count: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, count));
}

/** Text as vim prints it: a control character in caret notation, such as `^M`. nvim sends the command line raw. */
function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces
  return text.replace(/[\x00-\x1f\x7f]/g, (char) =>
    char === "\x7f" ? "^?" : `^${String.fromCharCode(char.charCodeAt(0) + 64)}`,
  );
}
