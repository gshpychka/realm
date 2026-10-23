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
