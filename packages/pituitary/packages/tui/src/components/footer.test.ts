import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { fakeSessionState, type Limits, type RpcSessionState, type SessionStats } from "@pituitary/rpc";
import { FIREBOX, footerStyle, PALETTE_NAMES } from "../footer-style.ts";
import { glyphs } from "../glyphs.ts";
import { gruvbox } from "../theme.ts";
import { aroundCard, type FooterProps, footerParts, footerRows, type Row, type Seg } from "./footer.tsx";

const NOW = 1_900_000_000_000;
const HOUR = 3_600_000;
const WIDE = 200;

const limits = (five: number, week: number, patch: Partial<Limits> = {}): Limits => ({
  status: "allowed",
  binding: "5h",
  windows: [
    { id: "5h", utilization: five, resetsAt: NOW + 0.7 * HOUR },
    { id: "7d", utilization: week, resetsAt: NOW + 80 * HOUR },
  ],
  extra: null,
  receivedAt: NOW,
  ...patch,
});

const props = (patch: Partial<FooterProps> = {}): FooterProps => ({
  state: { ...fakeSessionState, model: { ...fakeSessionState.model, provider: "anthropic" } as never },
  stats: { cost: 0.42, contextUsage: { percent: 14 } } as SessionStats,
  statuses: {},
  turnStatuses: {},
  cwd: `${homedir()}/projects/work/pituitary`,
  branch: "footer",
  pull: { number: 57, url: "https://github.com/o/r/pull/57", state: "open" },
  limits: null,
  ...patch,
});

const text = (segs: readonly Seg[]) => segs.map((seg) => seg.text).join("");

/** A row as the terminal shows it, the hearth as blank cells. */
function drawn(row: Row, columns: number): string {
  const left = text(row.left);
  const right = `${text(row.right)}${" ".repeat(row.hearth)}`;
  return `${left}${" ".repeat(Math.max(0, columns - Bun.stringWidth(left) - Bun.stringWidth(right)))}${right}`;
}

function rows(
  patch: Partial<FooterProps> = {},
  columns = WIDE,
  env: Record<string, string> = {},
  open = false,
) {
  return footerRows(footerParts(props(patch), NOW), columns, footerStyle(env), open);
}

const all = (list: Row[]) => list.flatMap((row) => [...row.left, ...row.right]);
const find = (list: Row[], wanted: string) => all(list).find((seg) => seg.text === wanted);

test("a remote workspace names the agent and keeps its absolute guest path", () => {
  const remote = footerParts(props({ cwd: "/work", location: "builder", branch: null, pull: null }), NOW);
  expect(remote.path).toBe("builder:/work");
  expect(remote.branch).toBeNull();
  expect(remote.pull).toBeNull();
});

describe("footerStyle", () => {
  test("defaults to arrows, ember, and an eight-cell hearth, as does an unknown value", () => {
    const fallback = footerStyle({});
    const unknown = footerStyle({
      PITUITARY_FOOTER_SEPARATOR: "zigzag",
      PITUITARY_FOOTER_PALETTE: "plaid",
      PITUITARY_FOOTER_HEARTH: "wide",
    });
    expect(unknown).toEqual(fallback);
    expect(fallback.separator.edge).toEqual({ kind: "glyph", closes: "\u{e0b0}", opens: "\u{e0b2}" });
    expect(fallback.palette.outerLeft).toBe(gruvbox.bg2);
    expect(fallback.hearth).toBe(8);
  });

  test("holds the hearth between 3 and 16 cells", () => {
    expect(footerStyle({ PITUITARY_FOOTER_HEARTH: "1" }).hearth).toBe(3);
    expect(footerStyle({ PITUITARY_FOOTER_HEARTH: "12" }).hearth).toBe(12);
    expect(footerStyle({ PITUITARY_FOOTER_HEARTH: "40" }).hearth).toBe(16);
  });

  test("plain glyphs draw every separator as a hard edge", () => {
    for (const name of ["slant", "backslant", "arrow", "gap"]) {
      const plain = footerStyle({ PITUITARY_FOOTER_SEPARATOR: name, PITUITARY_PLAIN_GLYPHS: "1" });
      expect(plain.separator).toEqual(footerStyle({ PITUITARY_FOOTER_SEPARATOR: "none" }).separator);
    }
  });

  test("offers every palette of the ember, orange, and pastel orange groups", () => {
    expect(PALETTE_NAMES).toEqual([
      "ember",
      "embersoft",
      "emberwhisper",
      "emberdeep",
      "emberseams",
      "embertext",
      "emberwash",
      "smoulder",
      "orangemodel",
      "rustmodel",
      "rust",
      "rustcore",
      "ruststeps",
      "burnt",
      "orange",
      "orangehard",
      "rustorange",
      "tangerine",
      "orangesteps",
      "allorange",
      "borange",
      "blaze",
      "creamrust",
      "apricot",
      "peach",
    ]);
    const peach = footerStyle({ PITUITARY_FOOTER_PALETTE: "peach" }).palette;
    expect(peach.outerLeft).toBe("#fccd8f");
    expect(peach.signal.alarm).toBe("#9d0006");
  });
});

describe("separators", () => {
  const style = footerStyle({});
  const { bar, outerLeft, innerLeft, innerRight, outerRight } = style.palette;

  for (const [name, closes, opens, left, right] of [
    ["arrow", "\u{e0b0}", "\u{e0b2}", "\u{e0b1}", "\u{e0b3}"],
    ["slant", "\u{e0bc}", "\u{e0ba}", "\u{e0bb}", "\u{e0bb}"],
    ["backslant", "\u{e0b8}", "\u{e0be}", "\u{e0b9}", "\u{e0b9}"],
  ] as const) {
    test(`${name} draws its glyph where bands meet, in the fill it leaves over the one it enters`, () => {
      const [row] = rows({}, WIDE, { PITUITARY_FOOTER_SEPARATOR: name });
      const edges = [...(row?.left ?? []), ...(row?.right ?? [])].filter(
        (seg) => seg.text === closes || seg.text === opens,
      );
      expect(edges).toEqual([
        { text: closes, fg: outerLeft, bg: innerLeft },
        { text: closes, fg: innerLeft, bg: bar },
        { text: opens, fg: innerRight, bg: bar },
        { text: opens, fg: outerRight, bg: innerRight },
        { text: opens, fg: FIREBOX, bg: outerRight },
      ]);
      expect(text(row?.left ?? [])).toContain(`#57 ${left} ${glyphs.session} fake`);
      expect(text(row?.right ?? [])).toContain(`14% ${right} ${glyphs.card}`);
    });
  }

  test("none sets bands edge to edge, with a line inside them", () => {
    const [row] = rows({}, WIDE, { PITUITARY_FOOTER_SEPARATOR: "none" });
    const left = text(row?.left ?? []);
    expect(left).toBe(
      ` ~/projects/work/pituitary  ${glyphs.branch} footer ${glyphs.pullOpen} #57 │ ${glyphs.session} fake `,
    );
    expect(text(row?.right ?? [])).toStartWith(" ctx 14% │ ");
  });

  test("gap sets a cell of the bar between bands", () => {
    const [row] = rows({}, WIDE, { PITUITARY_FOOTER_SEPARATOR: "gap" });
    const gaps = [...(row?.left ?? []), ...(row?.right ?? [])].filter((seg) => seg.bg === bar);
    expect(gaps).toHaveLength(3);
    expect(text(row?.left ?? [])).toStartWith(" ~/projects/work/pituitary   ");
  });
});

describe("the card", () => {
  const style = footerStyle({});
  const { innerDim, innerText } = style.palette;

  test("holds the limits and the cost closed while every limit is at 80% or under", () => {
    const list = rows({ limits: limits(0.34, 0.12) });
    const right = text(list[0]?.right ?? []);
    expect(right).toContain(`ctx 14% ${"\u{e0b3}"} ${glyphs.card} `);
    expect(right).not.toContain("$0.42");
    expect(right).not.toContain("5h");
    expect(find(list, glyphs.card)).toMatchObject({ fg: innerDim, card: true });
  });

  test("takes amber past 70% and red past 90%, closed or open", () => {
    expect(find(rows({ limits: limits(0.75, 0.12) }), glyphs.card)?.fg).toBe(gruvbox.bright_yellow);
    const rejected = limits(0.2, 0.1, { status: "rejected" });
    expect(find(rows({ limits: rejected }), glyphs.card)?.fg).toBe(gruvbox.bright_red);
    expect(find(rows({ limits: limits(0.95, 0.1) }), glyphs.card)?.fg).toBe(gruvbox.bright_red);
  });

  test("opens on its own past 80%, with each window and the reset of the nearest", () => {
    const right = text(rows({ limits: limits(0.85, 0.71) })[0]?.right ?? []);
    expect(right).toContain(`${glyphs.card} $0.42 \u{e0b3} 5h 85% ↻ 42m \u{e0b3} wk 71% `);
  });

  test("opened by the operator, it shows cost, every window, and extra usage", () => {
    const extra = {
      status: "allowed",
      active: true,
      utilization: null,
      monthly: 0.42,
      resetsAt: NOW + 12 * 24 * HOUR,
      disabledReason: null,
    } as const;
    const list = rows({ limits: limits(0.34, 0.12, { extra }) }, WIDE, {}, true);
    const right = text(list[0]?.right ?? []);
    expect(right).toContain(`${glyphs.card} $0.42 \u{e0b3} 5h 34% \u{e0b3} wk 12% \u{e0b3} extra 42% `);
    expect(find(list, glyphs.card)).toMatchObject({ fg: innerText, bold: true });
    expect(find(list, "42%")?.fg).toBe(gruvbox.bright_yellow);
    const [before, card, after] = aroundCard(list[0]?.right ?? []);
    expect(text(before)).toEndWith(`ctx 14% ${"\u{e0b3}"} `);
    expect(text(card)).toBe(`${glyphs.card} $0.42 \u{e0b3} 5h 34% \u{e0b3} wk 12% \u{e0b3} extra 42%`);
    expect(text(after)).not.toContain("%");
  });

  test("extra usage past 80% opens it", () => {
    const extra = {
      status: "allowed",
      active: false,
      utilization: null,
      monthly: 0.85,
      resetsAt: null,
      disabledReason: null,
    } as const;
    expect(text(rows({ limits: limits(0.1, 0.1, { extra }) })[0]?.right ?? [])).toContain("extra 85%");
  });
});

describe("room", () => {
  const statuses = { lsp: "LSP active", mcp: "1/2 servers", note: "indexing 42 files" };
  /** The narrowest width one row holds at, and the row there. */
  function narrowest(patch: Partial<FooterProps>, env: Record<string, string> = {}): number {
    let columns = WIDE;
    while (rows(patch, columns - 1, env).length === 1) columns--;
    return columns;
  }

  test("one row cuts the directory first, then sheds the session's name, then the thinking level", () => {
    const at = narrowest({ statuses });
    const last = rows({ statuses }, at)[0];
    expect(last && drawn(last, at)).not.toContain(`${glyphs.session} fake`);
    expect(last && drawn(last, at)).not.toContain("medium");
    const whole = rows({ statuses }, WIDE)[0];
    const width =
      Bun.stringWidth(text(whole?.left ?? [])) + 1 + Bun.stringWidth(text(whole?.right ?? [])) + 8;
    // The directory keeps 12 of its 25 columns before anything else gives way.
    const cut = rows({ statuses }, width - 13)[0];
    expect(text(cut?.left ?? [])).toStartWith(" …k/pituitary ");
    expect(text(cut?.left ?? [])).toContain(`${glyphs.session} fake`);
    const named = rows({ statuses }, width - 14)[0];
    expect(text(named?.left ?? [])).not.toContain("fake");
    expect(text(named?.right ?? [])).toContain(`${glyphs.thinking} medium`);
  });

  test("two rows put the place and statuses above, the budget, model, and hearth below", () => {
    const [top, bottom] = rows({ statuses }, 80);
    expect(top?.hearth).toBe(0);
    expect(text(top?.left ?? [])).toContain(`${glyphs.branch} footer`);
    expect(text(top?.right ?? [])).toBe(`${glyphs.lsp} ${glyphs.mcp} 1/2 • indexing 42 files `);
    expect(top?.right[0]?.fg).toBe(gruvbox.bg4);
    expect(bottom?.left).toEqual([]);
    expect(text(bottom?.right ?? [])).toContain(`ctx 14%`);
    expect(bottom?.hearth).toBe(8);
  });

  test("the lower row sheds the thinking level, then narrows the hearth to ¾, ½, and 3 cells", () => {
    const hearths: number[] = [];
    let thinking = true;
    for (let columns = 80; columns > 20; columns--) {
      const bottom = rows({ statuses }, columns)[1];
      const right = text(bottom?.right ?? []);
      if (bottom && hearths.at(-1) !== bottom.hearth) hearths.push(bottom.hearth);
      if (bottom && bottom.hearth < 8) expect(right).not.toContain("medium");
      if (!right.includes("medium")) thinking = false;
      if (!thinking) expect(right).not.toContain("medium");
    }
    expect(hearths).toEqual([8, 6, 4, 3, 0]);
  });

  test("past the narrowest hearth the fire goes, then the reset, then the model's name; the figures stay", () => {
    const open = { limits: limits(1, 0.71) };
    const at = (columns: number) => rows(open, columns)[1] as Row;
    const bottoms = Array.from({ length: 60 }, (_, index) => at(80 - index));
    const cold = bottoms.findIndex((row) => row.hearth === 0);
    const reset = bottoms.findIndex((row) => !text(row.right).includes("↻"));
    const named = bottoms.findIndex((row) => !text(row.right).includes("fake-model-1"));
    expect(cold).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(cold);
    expect(named).toBeGreaterThan(reset);
    for (const row of bottoms.slice(0, 40)) {
      expect(text(row.right)).toContain("ctx 14%");
      expect(text(row.right)).toContain("$0.42");
      expect(text(row.right)).toMatch(/5h 100%.*wk 71%/);
    }
  });

  test("a chosen hearth width is the one the fire's slot takes", () => {
    expect(rows({}, WIDE, { PITUITARY_FOOTER_HEARTH: "12" })[0]?.hearth).toBe(12);
  });

  test("on the upper row statuses lose their words, then icons from the end, before the pull request", () => {
    const [top] = rows({ statuses }, 44);
    expect(text(top?.right ?? [])).not.toContain("indexing");
    const [tight] = rows({ statuses }, 20);
    expect(text(tight?.left ?? [])).toContain(`${glyphs.branch} footer`);
    expect(text(tight?.left ?? [])).not.toContain("#57");
  });

  test("wide and composed text fits every footer width without broken characters", () => {
    const patch = {
      cwd: `/work/${"資料🙂e\u0301".repeat(8)}`,
      branch: "改善🙂",
      state: {
        ...fakeSessionState,
        model: { ...fakeSessionState.model, id: "資料🙂e\u0301".repeat(8) },
      } as RpcSessionState,
    };
    for (let columns = 1; columns <= WIDE; columns++) {
      for (const row of rows(patch, columns)) {
        const value = text(row.left) + text(row.right);
        expect(Bun.stringWidth(value) + row.hearth).toBeLessThanOrEqual(columns);
        expect(value.isWellFormed()).toBe(true);
        expect(value).not.toMatch(/(?:^|…)\p{Mark}/u);
      }
    }
  });
});

describe("parts", () => {
  test("the pull request links to itself, coloured by its state", () => {
    const list = rows({ pull: { number: 57, url: "https://github.com/o/r/pull/57", state: "merged" } });
    expect(find(list, "#57")).toMatchObject({
      href: "https://github.com/o/r/pull/57",
      fg: gruvbox.bright_purple,
    });
  });

  test("the provider mark keeps its brand colour on a neutral band and takes the band's text on orange", () => {
    expect(find(rows(), glyphs.anthropic)?.fg).toBe("#d97757");
    const orange = rows({}, WIDE, { PITUITARY_FOOTER_PALETTE: "orangemodel" });
    expect(find(orange, glyphs.anthropic)?.fg).toBe(gruvbox.bg0);
  });

  test("the context percentage warns past 70% and alarms past 90%", () => {
    const at = (percent: number) =>
      find(rows({ stats: { cost: 0, contextUsage: { percent } } as SessionStats }), `${percent}%`)?.fg;
    expect(at(70)).toBe(gruvbox.fg1);
    expect(at(71)).toBe(gruvbox.bright_yellow);
    expect(at(93)).toBe(gruvbox.bright_red);
  });
});
