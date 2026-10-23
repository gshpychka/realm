/**
 * Decoder for the native conversation's JSON records, separated by LF.
 *
 * LF is the only delimiter, so U+2028 and U+2029 stay inside string values where
 * a general-purpose line reader would split them.
 */
export class JsonLineDecoder {
  private readonly utf8 = new TextDecoder("utf-8");
  /** Pieces of the record still arriving, joined only once its LF arrives, so each byte is read once. */
  private pending: string[] = [];

  /** Complete records contained in `chunk`, with any partial record held for the next call. */
  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.utf8.decode(chunk, { stream: true });
    const records: string[] = [];
    let start = 0;
    for (;;) {
      const lf = text.indexOf("\n", start);
      if (lf === -1) break;
      this.pending.push(text.slice(start, lf));
      const record = this.pending.join("").replace(/\r$/, "");
      this.pending = [];
      if (record.length > 0) records.push(record);
      start = lf + 1;
    }
    if (start < text.length) this.pending.push(text.slice(start));
    return records;
  }

  /** The trailing record when the stream ends without a final LF. */
  flush(): string[] {
    const record = this.pending.join("").replace(/\r$/, "");
    this.pending = [];
    return record.length > 0 ? [record] : [];
  }
}

/** One JSON record, LF-terminated. */
export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
