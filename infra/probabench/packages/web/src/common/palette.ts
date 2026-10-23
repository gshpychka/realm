/** Gruvbox Material accents; COLORS[0] matches --accent in base.css. */
const COLORS = [
  "#d8a657",
  "#7daea3",
  "#d3869b",
  "#a9b665",
  "#ea6962",
  "#b4a7d6",
  "#e78a4e",
  "#89b482",
] as const;
/** Once every color is in use, a reused color gets the next dash pattern. */
const DASHES = ["none", "8 4", "2 4", "8 3 2 3"] as const;

export interface ModelStyle {
  readonly color: string;
  /** An SVG stroke-dasharray. */
  readonly dash: string;
}

const FIRST: ModelStyle = { color: COLORS[0], dash: DASHES[0] };

/** Append order keeps each model's style stable as runs are added. */
export const modelStyles = (
  runs: ReadonlyArray<{ readonly model: string }>,
): ReadonlyMap<string, ModelStyle> => {
  const styles = new Map<string, ModelStyle>();
  for (const { model } of runs) {
    if (styles.has(model)) continue;
    const index = styles.size;
    // The fallbacks only satisfy noUncheckedIndexedAccess: both indices wrap.
    styles.set(model, {
      color: COLORS[index % COLORS.length] ?? FIRST.color,
      dash: DASHES[Math.floor(index / COLORS.length) % DASHES.length] ?? FIRST.dash,
    });
  }
  return styles;
};

/** Total lookup for models of the runs the map was built from; the fallback is unreachable there. */
export const styleOf = (styles: ReadonlyMap<string, ModelStyle>, model: string): ModelStyle =>
  styles.get(model) ?? FIRST;
