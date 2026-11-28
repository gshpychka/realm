/** Terminal cells are measured by whole graphemes, so clipping keeps emoji and combining marks intact. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A bounded viewport's initial row estimate; its native text still owns the wrapping. */
export function wrappedRows(text: string, columns: number): number {
  return text
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(Bun.stringWidth(line) / Math.max(1, columns))), 0);
}

export function headCells(text: string, columns: number): string {
  if (Bun.stringWidth(text) <= columns) return text;
  const room = Math.max(0, Math.floor(columns));
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    const candidate = out + segment;
    if (Bun.stringWidth(candidate) > room) break;
    out = candidate;
  }
  return out;
}

export function tailCells(text: string, columns: number): string {
  if (Bun.stringWidth(text) <= columns) return text;
  const room = Math.max(0, Math.floor(columns));
  let out = "";
  for (const { segment } of [...graphemes.segment(text)].reverse()) {
    const candidate = segment + out;
    if (Bun.stringWidth(candidate) > room) break;
    out = candidate;
  }
  return out;
}

/** The beginning of text, with a final ellipsis only when some of it was cut. */
export function ellipsize(text: string, columns: number): string {
  if (columns <= 0) return "";
  return Bun.stringWidth(text) <= columns ? text : `${headCells(text, columns - 1)}…`;
}

/**
 * `text` in at most `lines` rows of `columns` cells, broken at spaces where a word allows,
 * the last row ending in an ellipsis when some of it was cut.
 */
export function wrapCells(text: string, columns: number, lines: number): string[] {
  const rows: string[] = [];
  let rest = text.trim();
  while (rest && rows.length < lines) {
    if (rows.length === lines - 1 || Bun.stringWidth(rest) <= columns) {
      rows.push(ellipsize(rest, columns));
      break;
    }
    const head = headCells(rest, columns);
    // A grapheme wider than the row leaves nothing to break, so the row ends there.
    if (!head) {
      rows.push(ellipsize(rest, columns));
      break;
    }
    // A cut inside a word moves back to the space before it, unless the word fills the row.
    const space = rest.charAt(head.length) === " " ? head.length : head.lastIndexOf(" ");
    const cut = space > 0 ? space : head.length;
    rows.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return rows;
}

/** `line` cut into rows of `columns` cells, as a terminal wraps a command's output. */
function cellRows(line: string, columns: number): string[] {
  if (Bun.stringWidth(line) <= columns) return [line];
  const rows: string[] = [];
  let row = "";
  let cells = 0;
  for (const { segment } of graphemes.segment(line)) {
    const width = Bun.stringWidth(segment);
    if (row && cells + width > columns) {
      rows.push(row);
      row = "";
      cells = 0;
    }
    row += segment;
    cells += width;
  }
  rows.push(row);
  return rows;
}

/**
 * The last `rows` screen rows that `lines` fill when each wraps at `columns` cells, and how
 * many rows come before them. Only the lines it shows are cut, so a long output costs no more
 * than its tail.
 */
export function tailRows(
  lines: readonly string[],
  columns: number,
  rows: number,
): { shown: string[]; hidden: number } {
  const width = Math.max(1, Math.floor(columns));
  const shown: string[] = [];
  let hidden = 0;
  let index = lines.length - 1;
  for (; index >= 0 && shown.length < rows; index--) {
    const wrapped = cellRows(lines[index] ?? "", width);
    const taken = wrapped.slice(-(rows - shown.length));
    hidden += wrapped.length - taken.length;
    shown.unshift(...taken);
  }
  for (; index >= 0; index--) hidden += Math.max(1, Math.ceil(Bun.stringWidth(lines[index] ?? "") / width));
  return { shown, hidden };
}
