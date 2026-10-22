import { gruvbox as G, gruvboxLight as L } from "./theme.ts";

/** How two bands meet: at a hard edge, across a cell of the bar, or through a Powerline glyph. */
export type Edge =
  | { kind: "hard" }
  | { kind: "gap" }
  | {
      kind: "glyph";
      /** On the footer's left half, in the fill of the band it closes over the fill after it. */
      closes: string;
      /** On the footer's right half, in the fill of the band it opens over the fill before it. */
      opens: string;
    };

export interface Separator {
  edge: Edge;
  /** The divider between parts inside a band, on the footer's left half and on its right half. */
  inner: { left: string; right: string };
}

export type SeparatorName = "none" | "slant" | "backslant" | "arrow" | "gap";

// Codepoints as the Nerd Fonts Symbols font names them: https://github.com/ryanoasis/nerd-fonts/wiki/Glyph-Sets-and-Code-Points
const SEPARATORS: Record<SeparatorName, Separator> = {
  none: { edge: { kind: "hard" }, inner: { left: "│", right: "│" } },
  slant: {
    edge: { kind: "glyph", closes: "\u{e0bc}", opens: "\u{e0ba}" },
    inner: { left: "\u{e0bb}", right: "\u{e0bb}" },
  },
  backslant: {
    edge: { kind: "glyph", closes: "\u{e0b8}", opens: "\u{e0be}" },
    inner: { left: "\u{e0b9}", right: "\u{e0b9}" },
  },
  arrow: {
    edge: { kind: "glyph", closes: "\u{e0b0}", opens: "\u{e0b2}" },
    inner: { left: "\u{e0b1}", right: "\u{e0b3}" },
  },
  gap: { edge: { kind: "gap" }, inner: { left: "│", right: "│" } },
};

/** How a figure past 70% (warn) or 90% (alarm) draws; a calm one takes its band's text. */
export interface Hot {
  fg: string;
  bg?: string;
  bold: boolean;
}

export interface Palette {
  bar: string;
  outerLeft: string;
  outerRight: string;
  innerLeft: string;
  innerRight: string;
  textLeft: string;
  dimLeft: string;
  textRight: string;
  dimRight: string;
  innerText: string;
  innerDim: string;
  /** The divider inside bands. */
  seam: string;
  /** The branch's name. */
  accent: string;
  /** Whether the directory, the branch where it takes the inner text, and the model's name are bold. */
  bold: boolean;
  hot: Record<"warn" | "alarm", Hot>;
  /** Colours for what a status, or a pull request, says about its state. */
  signal: { good: string; busy: string; alarm: string; info: string; quiet: string; merged: string };
  /** Whether the provider mark keeps its brand colour on the model band, which holds for the dark neutrals. */
  brandMark: boolean;
}

/** A palette as the design names it; unset colours take the defaults `resolve` gives them. */
interface Spec {
  OL: string;
  OR: string;
  I?: string;
  IL?: string;
  IR?: string;
  bar?: string;
  text?: string;
  dim?: string;
  textL?: string;
  dimL?: string;
  textR?: string;
  dimR?: string;
  iText?: string;
  iDim?: string;
  seam?: string;
  accent: string;
  bold?: boolean;
  hot?: "bright" | "faded" | "chip";
  chip?: Partial<Record<"warn" | "alarm", { fg: string; bg: string }>>;
  light?: boolean;
}

/** `a` mixed into `b`, `t` of the way from `b`. */
function mix(a: string, b: string, t: number): string {
  const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const [from, to] = [rgb(a), rgb(b)];
  return `#${from
    .map((value, index) => Math.round(value * t + (to[index] ?? 0) * (1 - t)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

const PEACH = mix(G.bright_orange, L.bg0, 0.32);
const PALE_PEACH = mix(G.bright_orange, L.bg0, 0.16);
const APRICOT = mix(G.bright_orange, L.bg1, 0.5);
const SMOULDER = mix(G.orange, G.bg0, 0.32);
const EMBER_WASH = mix(G.orange, G.bg0, 0.16);
const DARK_CHIP = { alarm: { bg: G.bg0_h, fg: G.bright_red } };

const solid = (fill: string, text: string, dim: string) => ({ OL: fill, OR: fill, text, dim, bold: true });

export type PaletteName = keyof typeof SPECS;

const SPECS = {
  // Ember: neutral bands, orange light.
  ember: { OL: G.bg2, OR: G.bg2, I: G.bg1, accent: G.bright_orange, textR: G.bright_orange },
  embersoft: {
    OL: G.bg1,
    OR: G.bg1,
    I: G.bg0_s,
    iText: G.fg2,
    iDim: G.bg4,
    accent: G.orange,
    textR: G.orange,
  },
  emberwhisper: {
    OL: G.bg0_s,
    OR: G.bg0_s,
    I: G.bg0,
    bar: G.bg0_h,
    text: G.fg4,
    dim: G.bg4,
    iText: G.fg4,
    iDim: G.bg3,
    accent: G.orange,
    textR: G.bright_orange,
  },
  emberdeep: {
    OL: G.bg3,
    OR: G.bg3,
    I: G.bg1,
    bar: G.bg0_h,
    text: G.fg0,
    dim: G.fg3,
    accent: G.bright_orange,
    textR: G.bright_orange,
    bold: true,
  },
  emberseams: { OL: G.bg2, OR: G.bg2, I: G.bg1, accent: G.bright_orange, seam: G.orange },
  embertext: {
    OL: G.bg2,
    OR: G.bg2,
    I: G.bg1,
    text: G.bright_orange,
    dim: G.orange,
    iText: G.fg1,
    iDim: G.orange,
    accent: G.bright_orange,
    seam: G.orange,
    bold: true,
  },
  emberwash: { OL: G.bg2, OR: G.bg2, I: EMBER_WASH, accent: G.bright_orange, textR: G.bright_orange },
  smoulder: {
    OL: SMOULDER,
    OR: SMOULDER,
    I: G.bg1,
    text: G.bright_orange,
    dim: G.fg4,
    accent: G.bright_orange,
    bold: true,
  },

  // Orange: orange bands.
  orangemodel: {
    OL: G.bg2,
    OR: G.orange,
    I: G.bg1,
    textR: G.bg0,
    dimR: G.bg1,
    accent: G.bright_orange,
    bold: true,
  },
  rustmodel: {
    OL: G.bg2,
    OR: L.faded_orange,
    I: G.bg1,
    textR: G.fg0,
    dimR: G.fg2,
    accent: G.bright_orange,
    bold: true,
  },
  rust: { ...solid(L.faded_orange, G.fg0, G.fg2), I: G.bg1, accent: G.bright_orange },
  rustcore: {
    OL: G.bg2,
    OR: G.bg2,
    I: L.faded_orange,
    iText: G.fg0,
    iDim: G.fg2,
    accent: G.fg0,
    bold: true,
  },
  ruststeps: {
    ...solid(G.orange, G.bg0, G.bg1),
    I: L.faded_orange,
    iText: G.fg0,
    iDim: G.fg2,
    accent: G.fg0,
  },
  burnt: {
    ...solid(G.orange, G.bg0, G.bg1),
    I: L.faded_orange,
    bar: G.bg0_h,
    iText: G.fg0,
    iDim: G.fg2,
    accent: G.fg0,
  },
  orange: { ...solid(G.orange, G.bg0, G.bg1), I: G.bg1, accent: G.bright_orange },
  orangehard: { ...solid(G.orange, G.bg0, G.bg1), I: G.bg1, bar: G.bg0_h, accent: G.bright_orange },
  rustorange: {
    OL: L.faded_orange,
    OR: G.bright_orange,
    textL: G.fg0,
    dimL: G.fg2,
    textR: G.bg0,
    dimR: G.bg1,
    I: G.bg1,
    accent: G.bright_orange,
    bold: true,
  },
  tangerine: {
    OL: G.bg2,
    OR: G.bg2,
    I: G.orange,
    iText: G.bg0,
    iDim: G.bg1,
    accent: G.bg0,
    bold: true,
    hot: "chip",
    chip: DARK_CHIP,
  },
  orangesteps: {
    ...solid(G.bright_orange, G.bg0, G.bg1),
    I: G.orange,
    iText: G.bg0,
    iDim: G.bg1,
    accent: G.bg0,
    hot: "chip",
    chip: DARK_CHIP,
  },
  allorange: {
    OL: G.bright_orange,
    OR: G.bright_orange,
    IL: G.orange,
    IR: G.orange,
    bar: L.faded_orange,
    text: G.bg0,
    dim: G.bg1,
    iText: G.bg0,
    iDim: G.bg1,
    accent: G.bg0,
    bold: true,
    hot: "chip",
    chip: DARK_CHIP,
  },
  borange: { ...solid(G.bright_orange, G.bg0, G.bg1), I: G.bg1, accent: G.bright_orange },
  blaze: {
    ...solid(G.bright_orange, G.bg0_h, G.bg1),
    I: G.bg0_h,
    bar: G.bg0_h,
    iText: G.fg0,
    iDim: G.bg4,
    accent: G.bright_orange,
  },

  // Pastel orange: mixed swatches.
  creamrust: { ...solid(L.bg1, L.faded_orange, L.fg4), I: G.bg1, accent: G.bright_orange },
  apricot: { ...solid(APRICOT, G.bg0, G.bg2), I: G.bg1, accent: G.bright_orange },
  peach: {
    OL: PEACH,
    OR: PEACH,
    I: PALE_PEACH,
    bar: L.bg0,
    text: L.fg1,
    dim: L.fg4,
    iText: L.fg1,
    iDim: L.fg4,
    accent: L.faded_orange,
    hot: "faded",
    light: true,
    bold: true,
  },
} satisfies Record<string, Spec>;

const DARK_NEUTRALS: readonly string[] = [G.bg0_h, G.bg0, G.bg0_s, G.bg1, G.bg2, G.bg3, G.bg4];

const DARK_SIGNAL = {
  good: G.bright_green,
  busy: G.bright_yellow,
  alarm: G.bright_red,
  info: G.fg4,
  quiet: G.bg4,
  merged: G.bright_purple,
};
const LIGHT_SIGNAL = {
  good: L.faded_green,
  busy: L.faded_yellow,
  alarm: L.faded_red,
  info: L.fg4,
  quiet: L.bg4,
  merged: L.faded_purple,
};

function hot(spec: Spec): Palette["hot"] {
  if (spec.hot === "faded") {
    return { warn: { fg: L.faded_yellow, bold: true }, alarm: { fg: L.faded_red, bold: true } };
  }
  if (spec.hot === "chip") {
    const chip = { warn: { bg: G.yellow, fg: G.bg0 }, alarm: { bg: G.red, fg: G.fg0 }, ...spec.chip };
    return { warn: { ...chip.warn, bold: true }, alarm: { ...chip.alarm, bold: true } };
  }
  return { warn: { fg: G.bright_yellow, bold: false }, alarm: { fg: G.bright_red, bold: false } };
}

function resolve(spec: Spec): Palette {
  const inner = spec.I ?? G.bg1;
  const innerDim = spec.iDim ?? G.fg4;
  return {
    bar: spec.bar ?? G.bg0,
    outerLeft: spec.OL,
    outerRight: spec.OR,
    innerLeft: spec.IL ?? inner,
    innerRight: spec.IR ?? inner,
    textLeft: spec.textL ?? spec.text ?? G.fg1,
    dimLeft: spec.dimL ?? spec.dim ?? G.fg4,
    textRight: spec.textR ?? spec.text ?? G.fg0,
    dimRight: spec.dimR ?? spec.dim ?? G.fg4,
    innerText: spec.iText ?? G.fg1,
    innerDim,
    seam: spec.seam ?? innerDim,
    accent: spec.accent,
    bold: spec.bold ?? false,
    hot: hot(spec),
    signal: spec.light ? LIGHT_SIGNAL : DARK_SIGNAL,
    brandMark: DARK_NEUTRALS.includes(spec.OR),
  };
}

const PALETTES = Object.fromEntries(
  Object.entries(SPECS).map(([name, spec]) => [name, resolve(spec)]),
) as Record<PaletteName, Palette>;

/** Every palette's name, in the design's order. */
export const PALETTE_NAMES = Object.keys(SPECS) as PaletteName[];

/** The fill the fire burns against: gruvbox's darkest neutral. */
export const FIREBOX = G.bg0_h;

const HEARTH = { fallback: 8, least: 3, most: 16 };

export interface FooterStyle {
  separator: Separator;
  palette: Palette;
  /** Cells the fire's hearth spans at its widest. */
  hearth: number;
}

/**
 * The footer's look `env` asks for, each unknown or absent setting at its default. Plain glyphs
 * draw every separator as `none`, since the others are Nerd Fonts glyphs.
 */
export function footerStyle(env: Record<string, string | undefined> = process.env): FooterStyle {
  const hearth = /^\d+$/.test(env.PITUITARY_FOOTER_HEARTH ?? "")
    ? Math.min(HEARTH.most, Math.max(HEARTH.least, Number(env.PITUITARY_FOOTER_HEARTH)))
    : HEARTH.fallback;
  return {
    separator: env.PITUITARY_PLAIN_GLYPHS
      ? SEPARATORS.none
      : choose(SEPARATORS, env.PITUITARY_FOOTER_SEPARATOR, "arrow"),
    palette: choose(PALETTES, env.PITUITARY_FOOTER_PALETTE, "ember"),
    hearth,
  };
}

function choose<K extends string, T>(table: Record<K, T>, value: string | undefined, fallback: K): T {
  return value !== undefined && Object.hasOwn(table, value) ? table[value as K] : table[fallback];
}
