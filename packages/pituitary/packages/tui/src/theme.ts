/** gruvbox dark, hard background: the operator's pi theme. */
export const palette = {
  bg: "#1d2021",
  bar: "#282828",
  surface: "#32302f",
  rule: "#504945",
  selection: "#665c54",
  faint: "#7c6f64",
  muted: "#a89984",
  text: "#ebdbb2",
  bright: "#fbf1c7",
  red: "#fb4934",
  green: "#b8bb26",
  yellow: "#fabd2f",
  blue: "#83a598",
  purple: "#d3869b",
  aqua: "#8ec07c",
  orange: "#fe8019",
} as const;

/** gruvbox dark's swatches by their gruvbox names. */
export const gruvbox = {
  bg0_h: "#1d2021",
  bg0: "#282828",
  bg0_s: "#32302f",
  bg1: "#3c3836",
  bg2: "#504945",
  bg3: "#665c54",
  bg4: "#7c6f64",
  fg0: "#fbf1c7",
  fg1: "#ebdbb2",
  fg2: "#d5c4a1",
  fg3: "#bdae93",
  fg4: "#a89984",
  red: "#cc241d",
  yellow: "#d79921",
  orange: "#d65d0e",
  bright_red: "#fb4934",
  bright_green: "#b8bb26",
  bright_yellow: "#fabd2f",
  bright_purple: "#d3869b",
  bright_orange: "#fe8019",
} as const;

/** gruvbox light's neutrals, and the faded accents it draws text in. */
export const gruvboxLight = {
  bg0: "#fbf1c7",
  bg1: "#ebdbb2",
  bg4: "#a89984",
  fg1: "#3c3836",
  fg4: "#7c6f64",
  faded_red: "#9d0006",
  faded_green: "#79740e",
  faded_yellow: "#b57614",
  faded_purple: "#8f3f71",
  faded_orange: "#af3a03",
} as const;

/** The model companies' brand colours, which their marks draw in. */
export const brand = {
  /** Claude's terra cotta. */
  anthropic: "#d97757",
  /** OpenAI's green accent; the mark itself is monochrome. */
  openai: "#10a37f",
  /** Google blue, one colour of the multicolour mark. */
  google: "#4285f4",
} as const;

/** Colours by role, so screens stay consistent. */
export const theme = {
  bg: palette.bg,
  bar: palette.bar,
  barText: palette.text,
  user: palette.blue,
  assistant: palette.text,
  thinking: palette.faint,
  tool: palette.orange,
  ok: palette.green,
  error: palette.red,
  dim: palette.faint,
  border: palette.rule,
} as const;
