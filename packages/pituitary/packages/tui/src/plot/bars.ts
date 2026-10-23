/** Eighth-block glyphs, the finest vertical resolution a cell grid carries. */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** One glyph per sample, as tall as the sample sits between the lowest and the highest. */
export function sparkline(samples: readonly number[]): string {
  if (samples.length === 0) return "";
  const min = Math.min(...samples);
  const span = Math.max(...samples) - min || 1;
  return samples
    .map((sample) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((sample - min) / span) * BLOCKS.length))])
    .join("");
}

/** A bar `width` cells wide, filled to `fraction`. */
export function meter(fraction: number, width: number): { filled: string; empty: string } {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return { filled: "█".repeat(filled), empty: "░".repeat(width - filled) };
}

/** Left-aligned eighth blocks, the finest horizontal resolution a cell grid carries. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * A bar `width` cells wide, filled to `fraction` in eighths of a cell: whole cells, one
 * partial cell, and the cells left empty.
 */
export function gauge(fraction: number, width: number): { filled: string; partial: string; empty: number } {
  const eighths = Math.round(Math.min(1, Math.max(0, fraction)) * width * 8);
  const whole = Math.floor(eighths / 8);
  const partial = EIGHTHS[eighths % 8] ?? "";
  return { filled: "█".repeat(whole), partial, empty: width - whole - (partial ? 1 : 0) };
}
