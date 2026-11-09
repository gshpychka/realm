// Charging history, active policy and the remaining planned ramp.

const TAG = "victron-charging-card";
const SVG_NS = "http://www.w3.org/2000/svg";
const ENTITY_OPTIONS = {
  status: "status_entity",
  bms: "bms_limit_entity",
  policy: "policy_limit_entity",
  current: "current_entity",
  soc: "soc_entity",
};
const ACTION_OPTIONS = ["throttle_action", "restore_action"];
const REQUIRED = [...Object.values(ENTITY_OPTIONS), ...ACTION_OPTIONS, "history_hours"];
const NUMERIC = ["current", "bms", "policy", "soc"];
// Bounds the recorder query; long windows are additionally decimated per pixel.
const MAX_HISTORY_HOURS = 168;
// The DVCC user ceiling is unrestricted at -1.
const UNRESTRICTED = -1;
// Victron /Ac/ActiveIn/Source enum: 1 is Grid, the only source a ramp runs on.
const GRID_SOURCE = 1;
const RAMPING = "ramping";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REFRESH_MS = MINUTE;
// Gives the recorder time to commit the new mode before re-querying.
const MODE_REFRESH_DELAY_MS = 3_000;
const PENDING_TIMEOUT_MS = 45_000;
const TIME_STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880].map((m) => m * MINUTE);
// Recorded mode labels retain transitions independently of numeric readings.
const MODE_TONES = {
  "Ramping": "amber",
  "Normal charging": "sage",
  "Full charging override": "blue",
  "Generator / shore charging": "text",
  "Waiting for grid": "muted",
  "Waiting for data": "muted",
};
const SERIES = {
  current: { label: "Actual", unit: "A" },
  bms: { label: "BMS limit", unit: "A" },
  policy: { label: "Our limit", unit: "A" },
  soc: { label: "SoC", unit: "%" },
};

const STYLE = `
  :host { display: block; }
  ha-card {
    --vc-bg: #3c3c3c; --vc-lower: #373737; --vc-border: #4d4d4d;
    --vc-text: #e8e8e8; --vc-muted: #a8a8a8; --vc-blue: #4a90d0;
    --vc-amber: #f8a63a; --vc-sage: #8bb86a; --vc-mauve: #b294bb;
    --vc-error: var(--error-color, #f08a76);
    display: block; background: var(--vc-bg); color: var(--vc-text);
    border: 1px solid var(--vc-border); border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: none; overflow: hidden;
    font-family: var(--victron-live-font, "Museo Sans Rounded", ui-rounded, system-ui, sans-serif);
  }
  .card { container-type: inline-size; padding: 14px 16px 10px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: 0; }
  .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 12px; color: var(--vc-muted); }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 7px; border-radius: 999px;
    background: var(--vc-lower); border: 1px solid var(--vc-border); color: var(--vc-text);
  }
  .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tone); }
  .control { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .action {
    min-height: 44px; min-width: 104px; padding: 0 18px; border-radius: 10px; cursor: pointer;
    border: 1px solid var(--vc-border); background: var(--vc-lower); color: var(--vc-text);
    font: inherit; font-size: 14px; font-weight: 600;
  }
  .action:hover:not(:disabled) { border-color: var(--tone); }
  .action:focus-visible, svg:focus-visible { outline: 2px solid var(--primary-color, var(--vc-blue)); outline-offset: 2px; }
  .action:disabled { cursor: default; opacity: 0.5; }
  .note { font-size: 12px; color: var(--vc-muted); min-height: 1em; }
  .note.error { color: var(--vc-error); }
  .readings { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 12px; margin: 14px 0 6px; }
  .reading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .k { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vc-muted); white-space: nowrap; }
  .v { font-size: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .swatch { width: 14px; border-top: 2px solid var(--tone); }
  .swatch.soc { border-top-width: 1.5px; }
  .graph { position: relative; }
  svg { display: block; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
  .graph-note { position: absolute; top: 14px; left: 52px; font-size: 12px; color: var(--vc-muted); pointer-events: none; }
  .graph-note.error { color: var(--vc-error); }
  .tip {
    position: absolute; top: 8px; z-index: 1; pointer-events: none; min-width: 148px;
    padding: 7px 9px; border-radius: 8px; background: var(--vc-lower); border: 1px solid var(--vc-border);
    font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums;
  }
  .tip .when { font-weight: 600; }
  .tip .row { display: flex; align-items: center; gap: 6px; }
  .tip .row span:last-child { margin-left: auto; padding-left: 10px; }
  .tip .muted { color: var(--vc-muted); }
  [data-tone=amber], .tone-amber, .policy { --tone: var(--vc-amber); }
  [data-tone=sage], .tone-sage, .current { --tone: var(--vc-sage); }
  [data-tone=blue], .tone-blue, .bms { --tone: var(--vc-blue); }
  [data-tone=text], .tone-text { --tone: var(--vc-text); }
  [data-tone=muted], .tone-muted { --tone: var(--vc-muted); }
  .soc { --tone: var(--vc-mauve); }
  .axis { fill: var(--vc-muted); font-size: 11px; font-family: inherit; }
  .gridline { stroke: var(--vc-border); stroke-width: 1; }
  .band { fill: var(--tone); opacity: 0.75; }
  .marker { stroke: var(--vc-text); stroke-opacity: 0.28; stroke-dasharray: 2 3; }
  .now { stroke: var(--vc-text); stroke-opacity: 0.35; }
  .trace { fill: none; stroke: var(--tone); stroke-linejoin: round; stroke-linecap: round; }
  .trace.current { stroke-width: 2; }
  .trace.bms, .trace.policy { stroke-width: 1.5; stroke-linecap: butt; }
  .trace.soc { stroke-width: 1.25; stroke-opacity: 0.8; }
  .trace.projection { stroke-dasharray: 5 4; stroke-opacity: 0.85; }
  .area { fill: var(--vc-mauve); fill-opacity: 0.07; }
  .cursor { stroke: var(--vc-text); stroke-opacity: 0.6; }
  @container (max-width: 420px) {
    .head { flex-direction: column; align-items: stretch; }
    .control { align-items: stretch; }
    .readings { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
`;

function el(tag, className, parent, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (n) => Math.round(n * 10) / 10;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

function parseState(key, state) {
  if (typeof state !== "string" || state === "unavailable" || state === "unknown" || state.trim() === "") return null;
  if (key === "status") return state;
  const n = Number(state);
  if (!Number.isFinite(n)) return null;
  if (key === "bms" && n < 0) return null;
  if (key === "soc" && (n < 0 || n > 100)) return null;
  if (key === "policy" && n < 0) return n === UNRESTRICTED ? UNRESTRICTED : null;
  return n;
}

// Unrestricted is a mode, not an amperage: it breaks the numeric trace.
const plotted = (key, v) => finite(v) && !(key === "policy" && v === UNRESTRICTED);

function pushPoint(points, t, v) {
  const last = points[points.length - 1];
  if (last && t <= last.t) {
    if (t === last.t) last.v = v;
    return;
  }
  points.push({ t, v });
}

// HA returns one array per entity; only the first item names its entity_id and
// later minimal entries carry just state/last_changed. The first entry is the
// state at the window start, so a series never begins before its first timestamp.
function parseHistory(response, ids, startMs) {
  const rowsById = new Map();
  for (const rows of Array.isArray(response) ? response : []) {
    const id = Array.isArray(rows) ? rows[0]?.entity_id : undefined;
    if (typeof id === "string") rowsById.set(id, rows);
  }
  const series = {};
  for (const [key, id] of Object.entries(ids)) {
    const points = [];
    for (const row of rowsById.get(id) ?? []) {
      const t = Date.parse(row?.last_changed ?? row?.last_updated);
      if (Number.isFinite(t)) pushPoint(points, Math.max(t, startMs), parseState(key, row.state));
    }
    series[key] = points;
  }
  return series;
}

// Keeps first/min/max/last per pixel bucket so peaks survive; gaps are kept verbatim.
function decimate(points, key, t0, t1, buckets) {
  if (points.length <= buckets * 4) return points;
  const size = (t1 - t0) / buckets;
  const out = [];
  let group = [];
  let bucket = null;
  const flush = () => {
    if (!group.length) return;
    let lo = group[0];
    let hi = group[0];
    for (const p of group) {
      if (p.v < lo.v) lo = p;
      if (p.v > hi.v) hi = p;
    }
    const keep = new Set([group[0], lo, hi, group[group.length - 1]]);
    for (const p of group) if (keep.has(p)) out.push(p);
    group = [];
  };
  for (const p of points) {
    if (!plotted(key, p.v)) {
      flush();
      bucket = null;
      out.push(p);
      continue;
    }
    const b = Math.floor((p.t - t0) / size);
    if (b !== bucket) {
      flush();
      bucket = b;
    }
    group.push(p);
  }
  flush();
  return out;
}

// Contiguous coordinate runs; each run holds its last value until the next
// sample, gap or `end` (now). Nothing is drawn before a series' first sample.
function traceRuns(points, key, end, step, X, Y) {
  const runs = [];
  let run = null;
  points.forEach((p, i) => {
    if (!plotted(key, p.v)) {
      run = null;
      return;
    }
    const x = X(p.t);
    const y = Y(p.v);
    if (!run) runs.push((run = []));
    else if (step) run.push([x, run[run.length - 1][1]]);
    run.push([x, y]);
    const next = points[i + 1];
    if (!next || !plotted(key, next.v)) run.push([X(next ? next.t : Math.max(end, p.t)), y]);
  });
  return runs;
}

const linePath = (runs) =>
  runs.map((run) => "M" + run.map(([x, y]) => `${round(x)},${round(y)}`).join("L")).join("");

const areaPath = (runs, base) =>
  runs.map((run) =>
    `M${round(run[0][0])},${round(base)}L` + run.map(([x, y]) => `${round(x)},${round(y)}`).join("L") +
    `L${round(run[run.length - 1][0])},${round(base)}Z`).join("");

function valueAt(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  let found;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) {
      found = points[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found?.v;
}

function niceStep(range, count) {
  const raw = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
}

class VictronChargingCard extends HTMLElement {
  constructor() {
    super();
    this._states = {};
    this._series = null;
    this._historyAt = 0;
    this._gen = 0;
    this._width = 0;
    this._visible = false;
    this._cursor = null;
    this._pending = null;
    this._notice = null;
    this._build();
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Configuration is required.");
    const missing = REQUIRED.filter((key) => config[key] === undefined || config[key] === null || config[key] === "");
    if (missing.length) throw new Error(`Missing required options: ${missing.join(", ")}`);
    for (const key of Object.values(ENTITY_OPTIONS)) {
      if (typeof config[key] !== "string" || !/^[a-z_]+\.[a-z0-9_]+$/.test(config[key])) {
        throw new Error(`${key} must be an entity id.`);
      }
    }
    for (const key of ACTION_OPTIONS) {
      if (typeof config[key] !== "string" || !/^script\.[a-z0-9_]+$/.test(config[key])) {
        throw new Error(`${key} must be a script entity id.`);
      }
    }
    const hours = Number(config.history_hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HISTORY_HOURS) {
      throw new Error(`history_hours must be a number in (0, ${MAX_HISTORY_HOURS}].`);
    }
    this._config = { ...config, history_hours: hours };
    this._ids = Object.fromEntries(Object.entries(ENTITY_OPTIONS).map(([key, option]) => [key, config[option]]));
    this._states = {};
    this._series = null;
    this._historyAt = 0;
    this._historyError = null;
    this._gen++;
    this._loading = false;
    if (this._hass) this.hass = this._hass;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    let changed = first;
    for (const [key, id] of Object.entries(this._ids)) {
      const state = hass.states[id];
      if (state === this._states[key]) continue;
      const previous = this._states[key];
      this._states[key] = state;
      changed = true;
      this._appendLive(key, state);
      if (key === "status" && previous && previous.state !== state?.state) this._modeChanged();
    }
    if (!changed) return;
    this._checkPending();
    this._maybeLoad();
    this._scheduleRender();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    this._resize = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      if (width !== this._width) {
        this._width = width;
        this._scheduleRender();
      }
    });
    this._resize.observe(this._els.graph);
    // History is fetched only while the card is on screen.
    this._intersection = new IntersectionObserver(([entry]) => {
      this._visible = entry.isIntersecting;
      this._maybeLoad();
    });
    this._intersection.observe(this);
    this._tick = setInterval(() => {
      this._maybeLoad();
      this._scheduleRender();
    }, REFRESH_MS);
    this._scheduleRender();
  }

  disconnectedCallback() {
    this._resize?.disconnect();
    this._intersection?.disconnect();
    clearInterval(this._tick);
    clearTimeout(this._modeRefresh);
    clearTimeout(this._pending?.timer);
    cancelAnimationFrame(this._frame);
    this._frame = null;
    this._pending = null;
    this._visible = false;
    this._gen++;
    this._loading = false;
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    el("style", "", root, STYLE);
    const card = el("ha-card", "", root);
    const body = el("div", "card", card);
    const head = el("div", "head", body);
    const heading = el("div", "", head);
    el("h2", "title", heading, "Charging");
    const meta = el("div", "meta", heading);
    const badge = el("span", "badge", meta);
    const since = el("span", "", meta);
    const control = el("div", "control", head);
    const button = el("button", "action", control);
    button.type = "button";
    button.addEventListener("click", () => this._act());
    const note = el("div", "note", control);
    note.setAttribute("aria-live", "polite");

    const readings = el("div", "readings", body);
    const values = {};
    for (const [key, { label }] of Object.entries(SERIES)) {
      const item = el("div", `reading ${key}`, readings);
      const k = el("span", "k", item);
      el("i", `swatch ${key}`, k);
      k.append(label);
      values[key] = el("span", "v", item);
    }

    const graph = el("div", "graph", body);
    const chart = svg("svg", { tabindex: 0, role: "group" }, graph);
    chart.setAttribute("aria-label", "Charging history. Arrow keys move the inspector, Page Up and Page Down jump between mode changes.");
    for (const type of ["pointerdown", "pointermove"]) chart.addEventListener(type, (e) => this._onPointer(e));
    chart.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && this._hideCursor());
    chart.addEventListener("pointercancel", () => this._hideCursor());
    chart.addEventListener("keydown", (e) => this._onKey(e));
    chart.addEventListener("focus", () => {
      if (!this._cursor && this._geom) this._setCursor(this._geom.now);
    });
    chart.addEventListener("blur", () => this._hideCursor());
    const graphNote = el("div", "graph-note", graph);
    const tip = el("div", "tip", graph);
    tip.hidden = true;
    this._els = { badge, since, button, note, values, graph, chart, graphNote, tip };
  }

  _formats() {
    const hass = this._hass;
    const lang = hass.locale?.language || hass.language || undefined;
    const zone = hass.config?.time_zone || undefined;
    const timeFormat = hass.locale?.time_format;
    const hour12 = timeFormat === "12" ? true : timeFormat === "24" ? false : undefined;
    const key = `${lang}|${zone}|${hour12}`;
    if (this._formatKey === key) return this._format;
    const date = (options) => {
      try {
        return new Intl.DateTimeFormat(lang, { timeZone: zone, ...options });
      } catch {
        return new Intl.DateTimeFormat(undefined, options);
      }
    };
    const number = (options) => {
      try {
        return new Intl.NumberFormat(lang, options);
      } catch {
        return new Intl.NumberFormat(undefined, options);
      }
    };
    const parts = date({ year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    this._formatKey = key;
    this._format = {
      time: date({ hour: "2-digit", minute: "2-digit", hour12 }),
      dayTime: date({ weekday: "short", hour: "2-digit", minute: "2-digit", hour12 }),
      exact: date({ weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12 }),
      day: date({ weekday: "short", day: "numeric" }),
      amps: number({ maximumFractionDigits: 1 }),
      signed: number({ maximumFractionDigits: 1, signDisplay: "exceptZero" }),
      percent: number({ maximumFractionDigits: 0 }),
      // Milliseconds the configured zone is ahead of UTC at `t`, for aligned ticks.
      offset: (t) => {
        const p = Object.fromEntries(parts.formatToParts(t).map((x) => [x.type, Number(x.value)]));
        return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000;
      },
    };
    return this._format;
  }

  _formatValue(key, v) {
    const f = this._formats();
    if (key === "policy" && v === UNRESTRICTED) return "Unrestricted";
    if (!finite(v)) return "—";
    if (key === "soc") return `${f.percent.format(v)} %`;
    return `${(key === "current" ? f.signed : f.amps).format(v)} A`;
  }

  _appendLive(key, state) {
    if (!this._series) return;
    const points = this._series[key];
    const t = state ? Date.parse(state.last_changed) : Date.now();
    if (Number.isFinite(t)) pushPoint(points, t, parseState(key, state?.state));
    const cutoff = Date.now() - this._config.history_hours * HOUR;
    let remove = 0;
    while (remove + 1 < points.length && points[remove + 1].t < cutoff) remove++;
    if (remove) points.splice(0, remove);
  }

  _modeChanged() {
    if (this._notice?.error) this._notice = null;
    clearTimeout(this._modeRefresh);
    this._modeRefresh = setTimeout(() => {
      this._historyAt = 0;
      this._maybeLoad();
    }, MODE_REFRESH_DELAY_MS);
  }

  _maybeLoad() {
    if (!this._visible || !this._hass || !this._config || this._loading) return;
    if (Date.now() - this._historyAt < REFRESH_MS) return;
    this._loadHistory();
  }

  async _loadHistory() {
    const gen = this._gen;
    this._loading = true;
    const end = new Date();
    const start = new Date(end.getTime() - this._config.history_hours * HOUR);
    const ids = Object.values(this._ids).map(encodeURIComponent).join(",");
    const path = `history/period/${start.toISOString()}?filter_entity_id=${ids}` +
      `&end_time=${encodeURIComponent(end.toISOString())}` +
      "&minimal_response&no_attributes&significant_changes_only=1";
    try {
      const response = await this._hass.callApi("GET", path);
      if (gen !== this._gen) return;
      this._series = parseHistory(response, this._ids, start.getTime());
      for (const key of Object.keys(this._ids)) this._appendLive(key, this._states[key]);
      this._historyError = null;
    } catch (error) {
      if (gen !== this._gen) return;
      this._historyError = error?.message || error?.body?.message || "request failed";
    } finally {
      if (gen === this._gen) {
        this._loading = false;
        this._historyAt = Date.now();
        this._scheduleRender();
      }
    }
  }

  _scheduleRender() {
    if (this._frame || !this.isConnected) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      if (!this._hass || !this._config) return;
      this._renderLive();
      this._renderGraph();
    });
  }

  _status() {
    const status = this._states.status;
    return status && parseState("status", status.state) !== null ? status : null;
  }

  _control() {
    const status = this._status();
    const a = status?.attributes ?? {};
    const restore = a.phase === RAMPING;
    let blocked = null;
    if (!status) blocked = "Status unavailable";
    else if (a.ready !== true) blocked = "Controller not ready";
    else if (Number(a.grid_source) !== GRID_SOURCE) blocked = "Grid not active";
    return { restore, blocked };
  }

  async _act() {
    const { restore, blocked } = this._control();
    if (blocked || this._pending) return;
    const entity = restore ? this._config.restore_action : this._config.throttle_action;
    const pending = { restore };
    pending.timer = setTimeout(() => {
      if (this._pending !== pending) return;
      this._pending = null;
      this._notice = { error: true, text: `No telemetry change after ${PENDING_TIMEOUT_MS / 1000} s` };
      this._scheduleRender();
    }, PENDING_TIMEOUT_MS);
    this._pending = pending;
    this._notice = null;
    this._scheduleRender();
    try {
      await this._hass.callService("script", "turn_on", { entity_id: entity });
    } catch (error) {
      if (this._pending !== pending) return;
      clearTimeout(pending.timer);
      this._pending = null;
      this._notice = { error: true, text: `Action failed: ${error?.message || "unknown error"}` };
      this._scheduleRender();
    }
  }

  // Success is only what the controller reports, never the service call's receipt.
  _checkPending() {
    if (!this._pending) return;
    const phase = this._status()?.attributes?.phase;
    const reached = this._pending.restore
      ? ["normal charging", "override: full charging"].includes(phase)
      : phase === RAMPING;
    if (!reached) return;
    clearTimeout(this._pending.timer);
    this._pending = null;
  }

  _projection(now) {
    const status = this._status();
    const a = status?.attributes ?? {};
    const { elapsed_seconds: elapsed, remaining_seconds: remaining, duration_seconds: duration, target_current_a: target } = a;
    if (a.phase !== RAMPING || a.window_open !== true) return null;
    if (![elapsed, remaining, duration, target].every(finite) || duration <= 0 || remaining <= 0) return null;
    const anchor = Date.parse(status.last_updated);
    const end = anchor + remaining * 1000;
    if (!Number.isFinite(anchor) || end <= now) return null;
    return { anchor, end, from: target * clamp(elapsed / duration, 0, 1), target };
  }

  _renderLive() {
    const { badge, since, button, note, values } = this._els;
    const f = this._formats();
    const status = this._status();
    const label = status ? status.state : "Unavailable";
    badge.textContent = label;
    badge.dataset.tone = MODE_TONES[label] ?? "muted";

    let meta = "";
    if (status) {
      const changed = Date.parse(status.last_changed);
      if (Number.isFinite(changed)) {
        meta = `since ${(Date.now() - changed > 20 * HOUR ? f.dayTime : f.time).format(changed)}`;
      }
      const { remaining_seconds: remaining, duration_seconds: duration } = status.attributes;
      if (status.attributes.phase === RAMPING && status.attributes.window_open === true && finite(remaining) && finite(duration)) {
        meta += ` · ${Math.ceil(remaining / 60)} of ${Math.round(duration / 60)} min left`;
      }
    }
    since.textContent = meta;

    const { restore, blocked } = this._control();
    button.textContent = this._pending ? (this._pending.restore ? "Restoring…" : "Throttling…") : restore ? "Restore" : "Throttle";
    button.disabled = Boolean(blocked || this._pending);
    button.setAttribute("aria-busy", String(Boolean(this._pending)));
    button.dataset.tone = restore ? "sage" : "amber";
    note.className = this._notice?.error ? "note error" : "note";
    note.textContent = this._pending ? "Waiting for telemetry…" : this._notice?.text ?? blocked ?? "";

    for (const key of NUMERIC) {
      const state = this._states[key];
      values[key].textContent = this._formatValue(key, parseState(key, state?.state));
    }
  }

  _renderGraph() {
    const { chart, graphNote } = this._els;
    const width = this._width;
    if (!width) return;
    const f = this._formats();
    const height = Math.round(clamp(width * 0.45, 190, 300));
    const left = 44;
    const right = width - 38;
    const top = 14;
    const bottom = height - 34;
    const bandY = bottom + 4;
    const now = Date.now();
    const t0 = now - this._config.history_hours * HOUR;
    const projection = this._projection(now);
    const t1 = projection ? projection.end : now;
    const series = this._series ?? { status: [], current: [], bms: [], policy: [], soc: [] };

    graphNote.className = this._historyError ? "graph-note error" : "graph-note";
    graphNote.textContent = this._historyError
      ? `History unavailable: ${this._historyError}`
      : this._series ? "" : "Loading history…";

    let lo = 0;
    let hi = 0;
    for (const key of ["current", "bms", "policy"]) {
      for (const p of series[key]) {
        if (!plotted(key, p.v)) continue;
        lo = Math.min(lo, p.v);
        hi = Math.max(hi, p.v);
      }
    }
    if (projection) hi = Math.max(hi, projection.target);
    const yStep = niceStep(hi - lo || 10, Math.max(2, Math.floor((bottom - top) / 44)));
    const yMin = Math.floor(lo / yStep) * yStep;
    const yMax = Math.max(yStep, Math.ceil(hi / yStep) * yStep);
    const X = (t) => left + ((t - t0) / (t1 - t0)) * (right - left);
    const Y = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
    const S = (v) => bottom - (v / 100) * (bottom - top);

    chart.setAttribute("width", width);
    chart.setAttribute("height", height);
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    chart.replaceChildren();
    const clip = svg("clipPath", { id: "plot" }, svg("defs", {}, chart));
    svg("rect", { x: left, y: 0, width: right - left, height }, clip);

    for (let v = yMin; v <= yMax + yStep / 2; v += yStep) {
      svg("line", { class: "gridline", x1: left, x2: right, y1: round(Y(v)), y2: round(Y(v)) }, chart);
      svg("text", { class: "axis", x: left - 6, y: round(Y(v)) + 4, "text-anchor": "end" }, chart).textContent = f.amps.format(v);
    }
    svg("text", { class: "axis", x: left - 6, y: top - 4, "text-anchor": "end" }, chart).textContent = "A";
    for (const v of [0, 50, 100]) {
      svg("text", { class: "axis", x: right + 6, y: round(S(v)) + 4 }, chart).textContent = `${v}%`;
    }

    const span = t1 - t0;
    const maxTicks = Math.max(2, Math.floor((right - left) / 76));
    const step = TIME_STEPS.find((s) => span / s <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1];
    const offset = f.offset(t0);
    for (let t = Math.ceil((t0 + offset) / step) * step - offset; t <= t1; t += step) {
      const x = X(t);
      if (x < left + 18 || x > right - 18) continue;
      svg("text", { class: "axis", x: round(x), y: height - 6, "text-anchor": "middle" }, chart)
        .textContent = (step >= 1440 * MINUTE ? f.day : f.time).format(t);
    }

    const plot = svg("g", { "clip-path": "url(#plot)" }, chart);
    const status = series.status;
    const transitions = [];
    status.forEach((p, i) => {
      if (p.v === null) return;
      const next = status[i + 1];
      const x1 = Math.max(X(p.t), left);
      const x2 = X(next ? next.t : Math.max(now, p.t));
      if (x2 > x1) {
        svg("rect", { class: `band tone-${MODE_TONES[p.v] ?? "muted"}`, x: round(x1), y: bandY, width: round(x2 - x1), height: 6 }, plot);
      }
      const prev = status[i - 1];
      if (prev && prev.v !== null && prev.v !== p.v && p.t >= t0) transitions.push({ t: p.t, from: prev.v, to: p.v });
    });
    for (const { t } of transitions) {
      svg("line", { class: "marker", x1: round(X(t)), x2: round(X(t)), y1: top, y2: bandY + 6 }, plot);
    }

    const buckets = Math.max(1, Math.round(right - left));
    const runs = (key, scale, isStep) =>
      traceRuns(decimate(series[key], key, t0, now, buckets), key, now, isStep, X, scale);
    const socRuns = runs("soc", S, true);
    svg("path", { class: "area", d: areaPath(socRuns, bottom) }, plot);
    svg("path", { class: "trace soc", d: linePath(socRuns) }, plot);
    svg("path", { class: "trace bms", d: linePath(runs("bms", Y, true)) }, plot);
    svg("path", { class: "trace policy", d: linePath(runs("policy", Y, true)) }, plot);
    if (projection) {
      const d = `M${round(X(projection.anchor))},${round(Y(projection.from))}L${round(X(projection.end))},${round(Y(projection.target))}`;
      svg("path", { class: "trace policy projection", d }, plot);
    }
    svg("path", { class: "trace current", d: linePath(runs("current", Y, true)) }, plot);

    const nowX = round(X(now));
    svg("line", { class: "now", x1: nowX, x2: nowX, y1: top, y2: bandY + 6 }, chart);
    if (projection) {
      svg("text", { class: "axis", x: nowX, y: top - 4, "text-anchor": "middle" }, chart).textContent = "Now";
    }

    this._geom = { left, right, top, bottom: bandY + 6, t0, t1, now, X, transitions, projection, series };
    if (this._cursor) this._setCursor(clamp(this._cursor.t, t0, t1), this._cursor.transition);
  }

  _onPointer(event) {
    const g = this._geom;
    if (!g) return;
    const px = clamp(event.clientX - this._els.chart.getBoundingClientRect().left, g.left, g.right);
    let nearest = null;
    for (const tr of g.transitions) {
      const distance = Math.abs(g.X(tr.t) - px);
      if (distance <= 8 && (!nearest || distance < nearest.distance)) nearest = { tr, distance };
    }
    if (nearest) this._setCursor(nearest.tr.t, nearest.tr);
    else this._setCursor(g.t0 + ((px - g.left) / (g.right - g.left)) * (g.t1 - g.t0));
  }

  _onKey(event) {
    const g = this._geom;
    if (!g) return;
    const t = this._cursor?.t ?? g.now;
    let next;
    if (event.key === "ArrowLeft") next = t - (g.t1 - g.t0) / 48;
    else if (event.key === "ArrowRight") next = t + (g.t1 - g.t0) / 48;
    else if (event.key === "Home") next = g.t0;
    else if (event.key === "End") next = g.t1;
    else if (event.key === "PageUp") next = [...g.transitions].reverse().find((tr) => tr.t < t)?.t ?? g.t0;
    else if (event.key === "PageDown") next = g.transitions.find((tr) => tr.t > t)?.t ?? g.t1;
    else if (event.key === "Escape") return this._hideCursor();
    else return;
    event.preventDefault();
    next = clamp(next, g.t0, g.t1);
    this._setCursor(next, g.transitions.find((tr) => tr.t === next));
  }

  _hideCursor() {
    this._cursor = null;
    this._cursorLine?.remove();
    this._els.tip.hidden = true;
  }

  _setCursor(t, transition) {
    const g = this._geom;
    const { chart, tip } = this._els;
    const f = this._formats();
    this._cursor = { t, transition };
    const x = round(g.X(t));
    this._cursorLine?.remove();
    this._cursorLine = svg("line", { class: "cursor", x1: x, x2: x, y1: g.top, y2: g.bottom }, chart);

    tip.replaceChildren();
    el("div", "when", tip, f.exact.format(t));
    const row = (key, label, value) => {
      const line = el("div", "row", tip);
      if (key) el("i", `swatch ${key}`, line);
      el("span", key ? "" : "muted", line, label);
      el("span", "", line, value);
    };
    if (t > g.now) {
      const p = g.projection;
      const v = p.from + ((t - p.anchor) / (p.end - p.anchor)) * (p.target - p.from);
      el("div", "muted", tip, "Projected ramp");
      row("policy", SERIES.policy.label, this._formatValue("policy", Math.min(v, p.target)));
    } else {
      if (transition) el("div", "", tip, `${transition.from} → ${transition.to}`);
      else el("div", "muted", tip, valueAt(g.series.status, t) ?? "Mode unknown");
      for (const key of NUMERIC) row(key, SERIES[key].label, this._formatValue(key, valueAt(g.series[key], t)));
    }
    tip.hidden = false;
    const width = tip.offsetWidth;
    const leftPos = x + 12 + width > this._width ? x - 12 - width : x + 12;
    tip.style.left = `${Math.max(0, leftPos)}px`;
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, VictronChargingCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === TAG)) {
  window.customCards.push({
    type: TAG,
    name: "Victron charging",
    description: "Charging mode, limits and history with the ramp throttle/restore action.",
  });
}
