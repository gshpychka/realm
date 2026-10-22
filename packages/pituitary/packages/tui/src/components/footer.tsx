import { type MouseEvent, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { Limits, RpcSessionState, SessionStats } from "@pituitary/rpc";
import { useEffect, useState } from "react";
import { FIREBOX, type FooterStyle, footerStyle } from "../footer-style.ts";
import type { PullRequest, PullState } from "../github/pull-request.ts";
import { type Glyph, glyphs } from "../glyphs.ts";
import {
  currentWindows,
  extraShown,
  extraTone,
  extraUsed,
  type LimitTone,
  percent as percentOf,
  RESET_SHOWN,
  untilShort,
  windowShort,
  windowTone,
  worst,
} from "../limits.ts";
import { modelName } from "../model-names.ts";
import { tilde } from "../place.ts";
import { type ProviderMark, providerMark } from "../provider.ts";
import { type Badge, badges, type Tone } from "../status.ts";
import { ellipsize, headCells, tailCells } from "../text-width.ts";
import { Link } from "./link.tsx";
import { MascotSlot } from "./mascot.tsx";

export interface FooterProps {
  state: RpcSessionState | null;
  stats: SessionStats | null;
  /** Extension statuses by key. */
  statuses: Readonly<Record<string, string>>;
  /** Extension statuses by key as the current turn began. */
  turnStatuses: Readonly<Record<string, string>>;
  cwd: string;
  /** The remote agent whose filesystem contains cwd. */
  location?: string;
  branch: string | null;
  /** The pull request opened from the branch, when GitHub has one. */
  pull?: PullRequest | null;
  /** The subscription's usage limits from the latest reply, absent until one reports them. */
  limits?: Limits | null;
}

/** Context use at which the percentage warns, then alarms, as pi's own footer does. */
const WARN_PERCENT = 70;
const ALARM_PERCENT = 90;

/** Use past which the limits and cost open on their own. */
const OPEN_AT = 0.8;

/** Characters of an unknown status kept beside its icon. */
const DETAIL_CHARS = 24;

/** Columns of the directory kept before anything else gives way. */
const PATH_KEPT = 12;

/** The narrowest hearth the footer draws. */
const HEARTH_LEAST = 3;

const PULL_GLYPH: Record<PullState, Glyph> = {
  open: "pullOpen",
  draft: "pullDraft",
  merged: "pullMerged",
  closed: "pullClosed",
};

/** How often the footer re-reads the clock, for limit windows that reset and times until they do. */
const CLOCK_MS = 30_000;

function useClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A run of text in one style. */
export interface Seg {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  /** Where a click on the run opens. */
  href?: string;
  /** Part of the card, which a click anywhere on opens and closes. */
  card?: boolean;
}

/** A footer row: `left` from the left edge, then `right` and a hearth of `hearth` cells against the right edge. */
export interface Row {
  left: Seg[];
  right: Seg[];
  /** Cells of the fire's hearth; 0 for none. */
  hearth: number;
}

const cells = (text: string) => Bun.stringWidth(text);
const span = (segs: readonly Seg[]) => segs.reduce((sum, seg) => sum + cells(seg.text), 0);

/** The end of `path` that fits `columns`, where the directory's own name is. */
function tail(path: string, columns: number): string {
  if (cells(path) <= columns) return path;
  if (columns <= 1) return "…";
  return `…${tailCells(path, columns - 1)}`;
}

/** The first `columns` of `segs`, the last kept cell an ellipsis when any are cut. */
function clipEnd(segs: readonly Seg[], columns: number): Seg[] {
  if (span(segs) <= columns) return [...segs];
  const kept: Seg[] = [];
  let room = columns - 1;
  for (const seg of segs) {
    if (room <= 0) break;
    const text = headCells(seg.text, room);
    kept.push({ ...seg, text });
    room -= cells(text);
    if (text !== seg.text) break;
  }
  const last = kept.at(-1);
  return columns > 0 ? [...kept, { text: "…", fg: last?.fg, bg: last?.bg }] : [];
}

/** The last `columns` of `segs`. */
function clipStart(segs: readonly Seg[], columns: number): Seg[] {
  const kept: Seg[] = [];
  let room = columns;
  for (const seg of [...segs].reverse()) {
    if (room <= 0) break;
    const text = tailCells(seg.text, room);
    kept.unshift({ ...seg, text });
    room -= cells(text);
    if (text !== seg.text) break;
  }
  return kept;
}

function contextTone(percent: number): LimitTone {
  if (percent > ALARM_PERCENT) return "alarm";
  if (percent > WARN_PERCENT) return "warn";
  return "calm";
}

/** A limit window as the footer draws it. */
interface LimitPart {
  name: string;
  percent: string;
  tone: LimitTone;
  /** When the window starts afresh, once it is far enough along to matter. */
  reset: string | null;
}

function limitParts(limits: Limits | null | undefined, now: number) {
  if (!limits) return { windows: [] as LimitPart[], extra: null, tone: "calm" as LimitTone, over: false };
  const current = currentWindows(limits, now);
  const top = current.reduce<(typeof current)[number] | undefined>(
    (best, window) => (best && (best.utilization ?? 0) >= (window.utilization ?? 0) ? best : window),
    undefined,
  );
  const windows = current.map((window) => {
    const used = window.utilization ?? 0;
    // Only the window nearest its limit says when it resets, and only once it is near.
    const reset = window === top && used >= RESET_SHOWN && window.resetsAt !== null;
    return {
      name: windowShort(window.id),
      percent: percentOf(used),
      tone: windowTone(window, limits),
      reset: reset && window.resetsAt !== null ? untilShort(window.resetsAt, now) : null,
    };
  });
  const spent = extraUsed(limits);
  const extra = extraShown(limits)
    ? { percent: spent === null ? null : percentOf(spent), tone: extraTone(limits) }
    : null;
  const over =
    current.some((window) => (window.utilization ?? 0) > OPEN_AT) ||
    Boolean(extra && spent !== null && spent > OPEN_AT);
  const tone = worst([...windows.map((window) => window.tone), extra?.tone ?? "calm"]);
  return { windows, extra, tone, over };
}

/** What the footer knows, in the words and figures it draws. */
export interface Parts {
  path: string;
  branch: string | null;
  pull: PullRequest | null;
  name: string | null;
  badges: Badge[];
  model: { mark: ProviderMark; name: string } | null;
  thinking: string | null;
  percent: number | null;
  cost: string | null;
  limits: ReturnType<typeof limitParts>;
}

export function footerParts(
  { state, stats, statuses, turnStatuses, cwd, location, branch, pull, limits }: FooterProps,
  now: number,
): Parts {
  const thinking = state?.thinkingLevel && state.thinkingLevel !== "off" ? state.thinkingLevel : null;
  const percent = stats?.contextUsage?.percent ?? null;
  return {
    path: location ? `${location}:${cwd}` : tilde(cwd),
    branch: branch || null,
    pull: branch && pull ? pull : null,
    name: state?.sessionName || null,
    badges: badges(statuses, turnStatuses).map((entry) => ({
      ...entry,
      detail: entry.detail === null ? null : ellipsize(entry.detail, DETAIL_CHARS),
    })),
    model: state?.model
      ? { mark: providerMark(state.model.provider), name: modelName(state.model.id) }
      : null,
    thinking,
    percent: percent === null ? null : Math.round(percent),
    cost: stats ? `$${stats.cost.toFixed(2)}` : null,
    limits: limitParts(limits, now),
  };
}

/** Padding of one cell either side of `segs`, all in the band's `fill`. */
function band(segs: readonly Seg[], fill: string): Seg[] {
  return [{ text: " " }, ...segs, { text: " " }].map((seg) => ({ ...seg, bg: seg.bg ?? fill }));
}

/** `groups` with the band's inner divider between them. */
function divided(groups: readonly (Seg[] | null)[], style: FooterStyle, side: "left" | "right"): Seg[] {
  const divider = style.separator.inner[side];
  return groups
    .filter((group): group is Seg[] => group !== null && group.length > 0)
    .flatMap((group, index) =>
      index === 0
        ? group
        : [{ text: " " }, { text: divider, fg: style.palette.seam }, { text: " " }, ...group],
    );
}

/** Where a band in `from` meets the fill `to`, on the footer's `side`. */
function meet(style: FooterStyle, side: "left" | "right", from: string, to: string): Seg[] {
  const { edge } = style.separator;
  const { bar } = style.palette;
  if (edge.kind === "hard") return [];
  if (edge.kind === "gap") return from === bar || to === bar ? [] : [{ text: " ", bg: bar }];
  return side === "left"
    ? [{ text: edge.closes, fg: from, bg: to }]
    : [{ text: edge.opens, fg: to, bg: from }];
}

/** Bands in their fills, from `start` to `end`, each meeting the next through the separator. */
function chain(
  style: FooterStyle,
  side: "left" | "right",
  bands: readonly { fill: string; segs: Seg[] }[],
  start: string | null,
  end: string | null,
): Seg[] {
  const kept = bands.filter((entry) => entry.segs.length > 0);
  const fills = [start, ...kept.map((entry) => entry.fill), end];
  const out: Seg[] = [];
  fills.forEach((fill, index) => {
    const next = fills[index + 1];
    const entry = kept[index - 1];
    if (entry) out.push(...band(entry.segs, entry.fill));
    if (fill !== null && next !== null && next !== undefined) out.push(...meet(style, side, fill, next));
  });
  return out;
}

interface PlaceOptions {
  path: string;
  pull: boolean;
  name: boolean;
}

/** The directory in the outer band, then the branch, its pull request, and the session's name. */
function place(p: Parts, style: FooterStyle, { path, pull, name }: PlaceOptions): Seg[] {
  const c = style.palette;
  const pr = pull ? p.pull : null;
  const tone = pr ? pullTone(style, pr.state) : undefined;
  const branch = p.branch
    ? [
        { text: `${glyphs.branch} `, fg: c.innerDim },
        { text: p.branch, fg: c.accent, bold: c.bold && c.accent === c.innerText },
        ...(pr
          ? [
              { text: ` ${glyphs[PULL_GLYPH[pr.state]]} `, fg: tone },
              { text: `#${pr.number}`, fg: tone, href: pr.url },
            ]
          : []),
      ]
    : null;
  const session =
    name && p.name
      ? [
          { text: `${glyphs.session} `, fg: c.innerDim },
          { text: p.name, fg: c.innerText },
        ]
      : null;
  return chain(
    style,
    "left",
    [
      { fill: c.outerLeft, segs: [{ text: path, fg: c.textLeft, bold: c.bold }] },
      { fill: c.innerLeft, segs: divided([branch, session], style, "left") },
    ],
    null,
    c.bar,
  );
}

function pullTone(style: FooterStyle, state: PullState): string {
  const { signal } = style.palette;
  return { open: signal.good, draft: signal.info, merged: signal.merged, closed: signal.alarm }[state];
}

/** The statuses on the bar: a healthy one as a quiet icon, any other as its icon and words in its tone. */
function statusRuns(p: Parts, style: FooterStyle, words: boolean, count = p.badges.length): Seg[] {
  const { signal } = style.palette;
  const colour: Record<Tone, string> = {
    ok: signal.quiet,
    off: signal.quiet,
    busy: signal.busy,
    alarm: signal.alarm,
    info: signal.info,
  };
  const shown = p.badges.slice(0, count).map((entry) => ({
    text:
      entry.tone !== "ok" && words && entry.detail
        ? `${glyphs[entry.glyph]} ${entry.detail}`
        : glyphs[entry.glyph],
    fg: colour[entry.tone],
  }));
  const cut = count < p.badges.length ? [{ text: "…", fg: signal.quiet }] : [];
  return [...shown, ...cut].flatMap((seg, index) => (index === 0 ? [seg] : [{ text: " " }, seg]));
}

interface BudgetOptions {
  thinking: boolean;
  /** Whether the operator opened the card. */
  open: boolean;
  /** Whether a hearth follows the model band. */
  hearth: boolean;
  /** Whether the nearest window says when it resets; it does by default. */
  resets?: boolean;
  /** Characters the model's name is cut to, 0 leaving the mark alone; whole by default. */
  nameRoom?: number;
}

/** A figure in the inner band, marked once it is past 70% or 90%. */
function figure(style: FooterStyle, text: string, tone: LimitTone, rest: string): Seg {
  if (tone === "calm") return { text, fg: rest };
  const hot = style.palette.hot[tone];
  return { text, fg: hot.fg, ...(hot.bg ? { bg: hot.bg } : {}), bold: hot.bold };
}

/**
 * The context percentage and the card, with the limits and cost behind it, then the model and
 * its thinking level, and the separator into the hearth.
 */
function budget(
  p: Parts,
  style: FooterStyle,
  { thinking, open, hearth, resets = true, nameRoom }: BudgetOptions,
): Seg[] {
  const c = style.palette;
  const { limits } = p;
  const shown = open || limits.over;
  const card: Seg = limits.over
    ? figure(style, glyphs.card, limits.tone, c.innerText)
    : open
      ? { text: glyphs.card, fg: c.innerText, bold: true }
      : figure(style, glyphs.card, limits.tone, c.innerDim);
  const hasCard = p.cost !== null || limits.windows.length > 0 || limits.extra !== null;
  const onCard: (Seg[] | null)[] = [
    hasCard ? [card, ...(shown && p.cost ? [{ text: ` ${p.cost}`, fg: c.innerText }] : [])] : null,
    ...(shown
      ? limits.windows.map((window) => [
          { text: `${window.name} `, fg: c.innerDim },
          figure(style, window.percent, window.tone, c.innerText),
          ...(resets && window.reset ? [{ text: ` ↻ ${window.reset}`, fg: c.innerDim }] : []),
        ])
      : []),
    shown && limits.extra
      ? limits.extra.percent === null
        ? [figure(style, "extra", limits.extra.tone, c.innerDim)]
        : [
            { text: "extra ", fg: c.innerDim },
            figure(style, limits.extra.percent, limits.extra.tone, c.innerText),
          ]
      : null,
  ];
  const groups: (Seg[] | null)[] = [
    p.percent === null
      ? null
      : [
          { text: "ctx ", fg: c.innerDim },
          figure(style, `${p.percent}%`, contextTone(p.percent), c.innerText),
        ],
    ...onCard.map((group) => group?.map((seg) => ({ ...seg, card: true })) ?? null),
  ];
  const name = p.model && nameRoom !== 0 ? ellipsize(p.model.name, nameRoom ?? cells(p.model.name)) : null;
  const model: Seg[] = p.model
    ? [
        { text: p.model.mark.glyph, fg: c.brandMark ? (p.model.mark.colour ?? c.textRight) : c.textRight },
        ...(name ? [{ text: ` ${name}`, fg: c.textRight, bold: c.bold }] : []),
        ...(thinking && p.thinking ? [{ text: ` ${glyphs.thinking} ${p.thinking}`, fg: c.dimRight }] : []),
      ]
    : [{ text: "connecting", fg: c.dimRight }];
  return chain(
    style,
    "right",
    [
      { fill: c.innerRight, segs: divided(groups, style, "right") },
      { fill: c.outerRight, segs: model },
    ],
    c.bar,
    hearth ? FIREBOX : null,
  );
}

/** The place fitted to `room` with the directory cut no shorter than `keep`, or null when it cannot fit. */
function fitPlace(
  p: Parts,
  style: FooterStyle,
  room: number,
  options: Omit<PlaceOptions, "path">,
  keep: number,
) {
  const whole = place(p, style, { ...options, path: p.path });
  const over = span(whole) - room;
  if (over <= 0) return whole;
  const columns = cells(p.path) - over;
  if (columns < Math.min(keep, cells(p.path))) return null;
  return place(p, style, { ...options, path: tail(p.path, columns) });
}

/** Hearth widths from the chosen one down: ¾, ½, then the narrowest. */
function hearths(widest: number): number[] {
  return [
    ...new Set(
      [widest, Math.round(widest * 0.75), Math.round(widest / 2), HEARTH_LEAST].map((w) =>
        Math.max(HEARTH_LEAST, w),
      ),
    ),
  ].filter((w) => w <= widest);
}

/**
 * The footer's rows at `columns`. One row holds it all while it can, shedding the session's name
 * and then the thinking level; past that the place and the statuses take a row above the budget,
 * the model, and the hearth, and each row sheds on its own. The directory is cut first throughout.
 */
export function footerRows(p: Parts, columns: number, style: FooterStyle, open: boolean): Row[] {
  const widest = style.hearth;
  const statuses = statusRuns(p, style, true);
  for (const [name, thinking] of [
    [true, true],
    [false, true],
    [false, false],
  ] as const) {
    const right = budget(p, style, { thinking, open, hearth: true });
    const trail = statuses.length > 0 ? 1 + span(statuses) : 0;
    const left = fitPlace(
      p,
      style,
      columns - span(right) - widest - 1 - trail,
      { name, pull: true },
      PATH_KEPT,
    );
    if (left) {
      return [
        {
          left: [...left, ...(statuses.length > 0 ? [{ text: " " }, ...statuses] : [])],
          right,
          hearth: widest,
        },
      ];
    }
  }
  return [top(p, style, columns), bottom(p, style, columns, open)];
}

/**
 * The place, and the statuses against the right edge. Past the session's name go the words beside
 * status icons, then the icons from the end, then the rest of the directory, then the pull request.
 */
function top(p: Parts, style: FooterStyle, columns: number): Row {
  const all = p.badges.length;
  const lean = { name: false, words: false, keep: PATH_KEPT, pull: true };
  const tries = [
    { ...lean, name: true, words: true, count: all },
    { ...lean, words: true, count: all },
    { ...lean, count: all },
    ...p.badges.map((_, index) => ({ ...lean, count: all - 1 - index })),
    { ...lean, count: 0, keep: 1 },
    { ...lean, count: 0, keep: 1, pull: false },
  ];
  for (const { name, words, count, keep, pull } of tries) {
    const statuses = statusRuns(p, style, words, count);
    const right = statuses.length > 0 ? [...statuses, { text: " " }] : [];
    const left = fitPlace(p, style, columns - span(right) - (right.length > 0 ? 1 : 0), { name, pull }, keep);
    if (left) return { left, right, hearth: 0 };
  }
  return {
    left: clipEnd(place(p, style, { path: "…", name: false, pull: false }), columns),
    right: [],
    hearth: 0,
  };
}

/**
 * The budget, the model, and the hearth, against the right edge. Past the narrowest hearth go the
 * fire, then the reset, then the model's name; the figures stay whole.
 */
function bottom(p: Parts, style: FooterStyle, columns: number, open: boolean): Row {
  const tries = [
    { hearth: style.hearth, thinking: true, resets: true },
    ...[...hearths(style.hearth), 0].map((hearth) => ({ hearth, thinking: false, resets: true })),
    { hearth: 0, thinking: false, resets: false },
  ];
  for (const { hearth, thinking, resets } of tries) {
    const right = budget(p, style, { thinking, open, hearth: hearth > 0, resets });
    if (span(right) + hearth <= columns) return { left: [], right, hearth };
  }
  const lean = { thinking: false, open, hearth: false, resets: false };
  const bare = budget(p, style, { ...lean, nameRoom: 0 });
  // The name takes a space before it, and keeps a character before its ellipsis.
  const room = columns - span(bare) - 1;
  const right = room >= 2 ? budget(p, style, { ...lean, nameRoom: room }) : bare;
  return { left: [], right: clipStart(right, columns), hearth: 0 };
}

const STYLE = footerStyle();

/**
 * Where the session is, what answers it, how full its context is, and what it has cost, in bands
 * from the screen's edges inward, ending in the fire's hearth.
 *
 * The card holds the usage limits and the cost: a click anywhere on it opens and closes it, and it
 * opens on its own once a limit or extra usage is past 80%.
 */
export function Footer(props: FooterProps) {
  const { width: columns } = useTerminalDimensions();
  const now = useClock();
  const [open, setOpen] = useState(false);
  const rows = footerRows(footerParts(props, now), columns, STYLE, open);
  const toggle = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setOpen((was) => !was);
  };
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={STYLE.palette.bar}>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order, top then bottom
        <FooterRow key={index} row={row} bar={STYLE.palette.bar} onCard={toggle} />
      ))}
    </box>
  );
}

/** `segs` before the card, the card from its first run to its last, dividers and all, and after it. */
export function aroundCard(segs: readonly Seg[]): [before: Seg[], card: Seg[], after: Seg[]] {
  const first = segs.findIndex((seg) => seg.card);
  if (first < 0) return [[...segs], [], []];
  const last = segs.findLastIndex((seg) => seg.card);
  return [segs.slice(0, first), segs.slice(first, last + 1), segs.slice(last + 1)];
}

function FooterRow({ row, bar, onCard }: { row: Row; bar: string; onCard: (event: MouseEvent) => void }) {
  const [before, card, after] = aroundCard(row.right);
  return (
    <box flexDirection="row" height={1} backgroundColor={bar}>
      <Runs segs={row.left} />
      <box flexGrow={1} />
      <Runs segs={before} />
      <Runs segs={card} onMouseDown={onCard} />
      <Runs segs={after} />
      {row.hearth > 0 ? (
        <box width={row.hearth} height={1} flexShrink={0} backgroundColor={FIREBOX}>
          <MascotSlot name="corner" width={row.hearth} height={1} />
        </box>
      ) : null}
    </box>
  );
}

function Runs({ segs, onMouseDown }: { segs: readonly Seg[]; onMouseDown?: (event: MouseEvent) => void }) {
  if (segs.length === 0) return null;
  return (
    <text flexShrink={0} wrapMode="none" onMouseDown={onMouseDown}>
      {segs.map((seg, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row's runs are drawn in order and never move
        <Run key={index} seg={seg} />
      ))}
    </text>
  );
}

function Run({ seg }: { seg: Seg }) {
  const attributes = seg.bold ? TextAttributes.BOLD : 0;
  return seg.href ? (
    <Link href={seg.href} fg={seg.fg} bg={seg.bg}>
      {seg.text}
    </Link>
  ) : (
    <span fg={seg.fg} bg={seg.bg} attributes={attributes}>
      {seg.text}
    </span>
  );
}
