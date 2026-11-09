// Recorded whole-AC-input power and the controller's remaining planned allowance.

const TAG = "victron-charging-chart";
const SVG_NS = "http://www.w3.org/2000/svg";
const ENTITY_OPTIONS = {
  status: "status_entity",
  power: "power_entity",
  battery: "battery_power_entity",
  limit: "limit_entity",
  voltage: "voltage_entity",
  soc: "soc_entity",
};
const SETTINGS_ENTITIES = {
  duration_entity: "number.victron_grid_ramp_duration",
  start_current_entity: "number.victron_grid_ramp_start_current",
  target_current_entity: "number.victron_grid_ramp_target_current",
  reset_defaults_entity: "button.victron_grid_ramp_reset_defaults",
};
const REQUIRED = [...Object.values(ENTITY_OPTIONS), "history_hours"];
const NUMERIC = ["power", "battery", "ceiling", "soc"];
// Bounds the recorder query; long windows are additionally decimated per pixel.
const MAX_HISTORY_HOURS = 168;

const RAMPING = "ramping";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const REFRESH_MS = MINUTE;
// Gives the recorder time to commit the new mode before re-querying.
const MODE_REFRESH_DELAY_MS = 3_000;
// Inspection events stay inside the feature.
const CONTAINED_EVENTS = [
  "action", "input", "change", "click", "dblclick", "contextmenu",
  "pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup",
  "touchstart", "touchmove", "touchend", "touchcancel", "keydown", "keyup",
];

// Recorded mode labels retain transitions independently of numeric readings.
const MODE_TONES = {
  "Ramping": "amber",
  "Normal input": "sage",
  "Input override": "blue",
  "No grid power": "muted",
  "Waiting for data": "muted",
};
const modeLabel = (mode) => Object.hasOwn(MODE_TONES, mode) ? mode : "Mode unavailable";
const SERIES = {
  power: { label: "Grid import", unit: "W" },
  battery: { label: "Battery power", unit: "W", description: "Negative power supplies household loads" },
  ceiling: { label: "Nominal ceiling", unit: "W", description: "The input ceiling is plotted during ramping" },
  planned: { label: "Planned allowance", unit: "W" },
  soc: { label: "SoC", unit: "%" },
};

const STYLE = `
  :host {
    --vc-text: var(--primary-text-color); --vc-muted: var(--secondary-text-color);
    --vc-border: var(--divider-color); --vc-amber: var(--warning-color);
    --vc-sage: var(--success-color); --vc-blue: var(--info-color);
    --vc-mauve: var(--purple-color, var(--accent-color));
    display: block; width: 100%; height: 124px;
  }
  .graph { position: relative; height: 100%; }
  .settings-button, .settings-close {
    appearance: none; border: 0; border-radius: 50%; background: var(--ha-card-background, var(--card-background-color));
    color: var(--vc-muted); cursor: pointer; width: 32px; height: 32px; font-size: 20px;
  }
  .settings-button { position: absolute; top: 2px; right: 2px; }
  .settings-button:focus-visible, .settings-close:focus-visible { outline: 2px solid var(--primary-color); }
  .settings-dialog {
    width: min(440px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); overflow: auto;
    padding: 16px; border: 1px solid var(--vc-border); border-radius: 16px;
    background: var(--ha-card-background, var(--card-background-color)); color: var(--vc-text);
  }
  .settings-dialog::backdrop { background: rgb(0 0 0 / 45%); }
  .settings-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .settings-heading h2 { margin: 0; font-size: 20px; }
  .settings-note { margin: 12px 0 0; color: var(--vc-muted); font-size: 14px; }
  svg { display: block; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
  svg:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
  .graph-note { position: absolute; top: 8px; left: 4px; font-size: 14px; color: var(--vc-muted); pointer-events: none; }
  .graph-note.error { color: var(--error-color); }
  .tip {
    position: fixed; inset: auto; margin: 0; box-sizing: border-box;
    width: min(288px, calc(100vw - 16px)); max-height: calc(100dvh - 16px); overflow: auto; padding: 8px 10px;
    border-radius: 8px; border: 1px solid var(--divider-color); box-shadow: var(--ha-card-box-shadow, none);
    background: var(--ha-card-background, var(--card-background-color)); color: var(--primary-text-color);
    font-size: 14px; line-height: 1.5; font-variant-numeric: tabular-nums;
    pointer-events: auto; user-select: text; -webkit-user-select: text; cursor: text;
  }
  .tip .when { font-weight: 600; }
  .tip .row { display: grid; grid-template-columns: 12px minmax(0, 1fr) max-content; align-items: center; gap: 8px; }
  .tip .row span:last-child { text-align: right; white-space: nowrap; }
  .tip button { appearance: none; background: none; border: 0; padding: 0; color: inherit; font: inherit; text-align: inherit; cursor: pointer; user-select: text; -webkit-user-select: text; }
  .tip button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .muted { color: var(--vc-muted); }
  .swatch { width: 12px; border-top: 2px solid var(--tone); }
  .swatch.soc { border-top-width: 1.5px; }
  .tone-amber, .ceiling, .planned { --tone: var(--vc-amber); }
  .tone-sage, .power { --tone: var(--vc-sage); }
  .tone-blue, .battery { --tone: var(--vc-blue); }
  .tone-text { --tone: var(--vc-text); }
  .tone-muted { --tone: var(--vc-muted); }
  .soc { --tone: var(--vc-mauve); }
  .gridline { stroke: var(--vc-border); stroke-width: 1; }
  .band { fill: var(--tone); opacity: 0.75; }
  .marker { stroke: var(--vc-text); stroke-opacity: 0.28; stroke-dasharray: 2 3; }
  .now { stroke: var(--vc-text); stroke-opacity: 0.35; }
  .trace { fill: none; stroke: var(--tone); stroke-linejoin: round; stroke-linecap: round; }
  .trace.power { stroke-width: 2; }
  .trace.battery, .trace.ceiling, .trace.planned { stroke-width: 1.5; stroke-linecap: butt; }
  .trace.soc { stroke-width: 1.25; stroke-opacity: 0.8; }
  .trace.projection { stroke-dasharray: 5 4; stroke-opacity: 0.85; }
  .area { fill: var(--vc-mauve); fill-opacity: 0.035; }
  .cursor { stroke: var(--vc-text); stroke-opacity: 0.6; }
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
  if (key === "soc" && (n < 0 || n > 100)) return null;
  return n;
}

const plotted = (key, v) => finite(v);

// Only explicit watt telemetry is meaningful; legacy charging-current attributes
// must leave a gap rather than being converted or relabelled.
function inputCeiling(state) {
  const a = state?.attributes;
  if (parseState("status", state?.state) === null || !a || !finite(a.input_limit_w) || a.input_limit_w < 0) return null;
  return a.input_limit_w;
}

function pushPoint(points, t, v) {
  const last = points[points.length - 1];
  if (last && t <= last.t) {
    if (t === last.t) last.v = v;
    return;
  }
  points.push({ t, v });
}

// HA returns one array per entity. Full status attributes are required for watt
// history; state changes and attribute updates use their own exact timestamps.
// The initial row is the state at the window start, never an earlier trace.
function parseHistory(response, ids, startMs) {
  const rowsById = new Map();
  for (const rows of Array.isArray(response) ? response : []) {
    const id = Array.isArray(rows) ? rows[0]?.entity_id : undefined;
    if (typeof id === "string") rowsById.set(id, rows);
  }
  const series = { ceiling: [] };
  for (const [key, id] of Object.entries(ids)) {
    const points = [];
    for (const row of rowsById.get(id) ?? []) {
      const t = Date.parse(row?.last_changed ?? row?.last_updated);
      if (Number.isFinite(t)) pushPoint(points, Math.max(t, startMs), parseState(key, row.state));
      if (key === "status") {
        const updated = Date.parse(row?.last_updated ?? row?.last_changed);
        if (Number.isFinite(updated)) pushPoint(series.ceiling, Math.max(updated, startMs), inputCeiling(row));
      }
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

class VictronChargingChart extends HTMLElement {
  constructor() {
    super();
    this._states = {};
    this._series = null;
    this._historyAt = 0;
    this._gen = 0;
    this._width = 0;
    this._height = 0;
    this._visible = false;
    this._cursor = null;
    this._pinned = false;
    // Bubble-phase isolation preserves the feature's own input handlers.
    for (const type of CONTAINED_EVENTS) this.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
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
    const hours = Number(config.history_hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HISTORY_HOURS) {
      throw new Error(`history_hours must be a number in (0, ${MAX_HISTORY_HOURS}].`);
    }
    const settings = { ...SETTINGS_ENTITIES };
    for (const key of Object.keys(settings)) {
      const id = config[key] ?? settings[key];
      const domain = key === "reset_defaults_entity" ? "button" : "number";
      if (typeof id !== "string" || !new RegExp(`^${domain}\\.[a-z0-9_]+$`).test(id)) {
        throw new Error(`${key} must be a ${domain} entity id.`);
      }
      settings[key] = id;
    }
    this._closeSettings();
    this._config = { ...config, ...settings, history_hours: hours };
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
    if (this._settingsCard && this._settingsDialog?.open) this._settingsCard.hass = hass;
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
    this._maybeLoad();
    this._scheduleRender();
  }

  connectedCallback() {
    this._reposition = () => this._positionTip();
    this._scrollRoots = [];
    for (let node = this; node;) {
      const root = node.getRootNode();
      root.addEventListener("scroll", this._reposition, { capture: true, passive: true });
      this._scrollRoots.push(root);
      node = root.host;
    }
    window.addEventListener("resize", this._reposition, { passive: true });
    this._resize = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width !== this._width || height !== this._height) {
        this._width = width;
        this._height = height;
        this._scheduleRender();
      }
    });
    this._resize.observe(this._els.graph);
    // History is fetched only while the feature is on screen.
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
    window.removeEventListener("resize", this._reposition);
    for (const root of this._scrollRoots ?? []) root.removeEventListener("scroll", this._reposition, true);
    this._scrollRoots = [];
    this._closeSettings();
    this._resize?.disconnect();
    this._intersection?.disconnect();
    clearInterval(this._tick);
    clearTimeout(this._modeRefresh);
    cancelAnimationFrame(this._frame);
    this._frame = null;
    this._hideCursor();
    this._visible = false;
    this._gen++;
    this._loading = false;
  }

  _build() {
    const root = this.attachShadow({ mode: "open" });
    el("style", "", root, STYLE);
    const graph = el("div", "graph", root);
    const chart = svg("svg", { tabindex: 0, role: "group" }, graph);
    chart.setAttribute("aria-label", "Grid input power history. Click to pin the inspector; arrow keys move it, Page Up and Page Down jump between mode changes.");
    // Click/tap pins until light dismiss; hover only previews and never moves a pinned inspector.
    chart.addEventListener("click", (e) => {
      this._pinned = true;
      this._inspect(e);
    });
    chart.addEventListener("pointermove", (e) => e.pointerType !== "touch" && !this._pinned && this._inspect(e));
    chart.addEventListener("pointerleave", (e) => e.pointerType !== "touch" && !this._pinned && this._hideCursor());
    chart.addEventListener("keydown", (e) => this._onKey(e));
    chart.addEventListener("focus", () => {
      if (!this._cursor && this._geom && chart.matches(":focus-visible")) this._setCursor(this._geom.now);
    });
    // Focus moves to the inspector when selecting its text; only an unpinned preview follows focus.
    chart.addEventListener("blur", (event) => {
      if (this._els.tip.contains(event.relatedTarget)) this._pinned = true;
      else if (!this._pinned) this._hideCursor();
    });
    const graphNote = el("div", "graph-note", graph);
    const settings = el("button", "settings-button", graph, "⚙");
    settings.type = "button";
    settings.title = "Ramp settings";
    settings.setAttribute("aria-label", "Ramp settings");
    settings.setAttribute("aria-haspopup", "dialog");
    for (const type of CONTAINED_EVENTS) settings.addEventListener(type, (e) => e.stopPropagation());
    settings.addEventListener("click", () => this._openSettings());
    const tip = el("div", "tip", graph);
    tip.setAttribute("popover", "auto");
    // Keep the preview mounted when focus leaves the graph for selectable text
    // or a native-history button; all interaction still stays inside the feature.
    tip.addEventListener("pointerdown", () => { this._pinned = true; });
    tip.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this._hideCursor();
    });
    tip.addEventListener("toggle", (event) => {
      if (event.newState === "closed") this._hideCursor();
    });
    this._els = { graph, chart, graphNote, tip };
  }

  _closeSettings() {
    const dialog = this._settingsDialog;
    this._settingsDialog = null;
    this._settingsCard = null;
    if (dialog?.open) dialog.close();
    dialog?.remove();
  }

  async _openSettings() {
    if (!this._config || !this._hass || !this.isConnected || this._settingsDialog) return;
    this._hideCursor();
    const dialog = el("dialog", "settings-dialog", this.shadowRoot);
    this._settingsDialog = dialog;
    dialog.setAttribute("aria-label", "Grid input ramp settings");
    for (const type of CONTAINED_EVENTS) dialog.addEventListener(type, (e) => e.stopPropagation());
    dialog.addEventListener("close", () => {
      if (this._settingsDialog === dialog) this._closeSettings();
    });
    const heading = el("div", "settings-heading", dialog);
    el("h2", "", heading, "Ramp settings");
    const close = el("button", "settings-close", heading, "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close settings");
    close.addEventListener("click", () => this._closeSettings());
    const content = el("div", "", dialog, "Loading settings…");
    el("p", "settings-note", dialog, "Changes apply to the next ramp.");
    const config = this._config;
    try {
      dialog.showModal();
      const helpers = await window.loadCardHelpers();
      if (this._settingsDialog !== dialog || !this.isConnected) return;
      const card = helpers.createCardElement({
        type: "entities",
        show_header_toggle: false,
        entities: [
          { entity: config.duration_entity, name: "Duration" },
          { entity: config.start_current_entity, name: "Start current" },
          { entity: config.target_current_entity, name: "Target current" },
          { entity: config.reset_defaults_entity, name: "Reset defaults" },
        ],
      });
      // Native theme initialization needs connected HA ancestry before hass.
      content.replaceChildren(card);
      await card.updateComplete;
      if (this._settingsDialog !== dialog || !this.isConnected) return;
      this._settingsCard = card;
      card.hass = this._hass;
      // The entities card's hass setter updates rows after its initial render.
      card.requestUpdate?.();
    } catch (error) {
      if (this._settingsDialog === dialog) content.textContent = `Settings unavailable: ${error?.message || "could not load native card"}`;
    }
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
    this._formatKey = key;
    this._format = {
      exact: date({ weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12 }),
      power: number({ maximumFractionDigits: 2 }),
      signed: number({ maximumFractionDigits: 2, signDisplay: "exceptZero" }),
      percent: number({ maximumFractionDigits: 0 }),
    };
    return this._format;
  }

  _formatValue(key, v) {
    const f = this._formats();
    if (!finite(v)) return "Unavailable";
    if (key === "soc") return `${f.percent.format(v)} %`;
    return `${(key === "battery" ? f.signed : f.power).format(v / 1000)} kW`;
  }

  _appendLive(key, state) {
    if (!this._series) return;
    const points = this._series[key];
    const t = state ? Date.parse(state.last_changed) : Date.now();
    if (Number.isFinite(t)) pushPoint(points, t, parseState(key, state?.state));
    if (key === "status") {
      const updated = state ? Date.parse(state.last_updated ?? state.last_changed) : Date.now();
      if (Number.isFinite(updated)) pushPoint(this._series.ceiling, updated, inputCeiling(state));
    }
    const cutoff = Date.now() - this._config.history_hours * HOUR;
    let remove = 0;
    while (remove + 1 < points.length && points[remove + 1].t < cutoff) remove++;
    if (remove) points.splice(0, remove);
    if (key === "status") {
      const ceiling = this._series.ceiling;
      let old = 0;
      while (old + 1 < ceiling.length && ceiling[old + 1].t < cutoff) old++;
      if (old) ceiling.splice(0, old);
    }
  }

  _modeChanged() {
    if (!this.isConnected) return;
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
      // Attribute-only status changes carry the accepted watt ceiling. Minimal
      // responses or significant-only history would silently lose those steps.
      "&significant_changes_only=0";
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
      if (this._hass && this._config) this._renderGraph();
    });
  }

  _status() {
    const status = this._states.status;
    return status && parseState("status", status.state) !== null ? status : null;
  }

  _projection(now) {
    const status = this._status();
    const a = status?.attributes ?? {};
    const {
      elapsed_seconds: elapsed, remaining_seconds: remaining, duration_seconds: duration,
      start_current_a: start, target_current_a: targetCurrent, input_voltage_v: voltage,
    } = a;
    if (a.phase !== RAMPING || a.window_open !== true || a.override === true || a.grid_available !== true || a.ready !== true) return null;
    if (![elapsed, remaining, duration, start, targetCurrent, voltage].every(finite) ||
        duration <= 0 || remaining <= 0 || elapsed < 0 || start < 0 || targetCurrent < start || voltage <= 0) return null;
    const anchor = Date.parse(status.last_updated);
    const end = anchor + remaining * 1000;
    if (!Number.isFinite(anchor) || end <= now) return null;
    const target = targetCurrent * voltage;
    const from = (start + (targetCurrent - start) * clamp(elapsed / duration, 0, 1)) * voltage;
    return { anchor, end, from, target };
  }

  _renderGraph() {
    const { chart, graphNote } = this._els;
    const width = this._width;
    const height = this._height;
    if (!width || !height) return;
    const left = 2;
    const right = width - 2;
    const top = 3;
    const bottom = height - 11;
    const bandY = bottom + 4;
    const now = Date.now();
    const t0 = now - this._config.history_hours * HOUR;
    const projection = this._projection(now);
    const t1 = projection ? projection.end : now;
    const series = this._series ?? { status: [], power: [], battery: [], ceiling: [], soc: [] };
    // Active ramp ceilings share the power scale; the normal connection rating stays inspectable.
    const displayed = { ...series, ceiling: series.ceiling.map(p => ({
      t: p.t, v: valueAt(series.status, p.t) === "Ramping" ? p.v : null,
    })) };

    graphNote.className = this._historyError ? "graph-note error" : "graph-note";
    graphNote.textContent = this._historyError
      ? `History unavailable: ${this._historyError}`
      : this._series ? "" : "Loading history…";

    let lo = 0;
    let hi = 0;
    for (const key of ["power", "battery", "ceiling"]) {
      for (const p of displayed[key]) {
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
    // SoC has its own fixed 0–100 % scale, independent of power.
    const S = (v) => bottom - (v / 100) * (bottom - top);

    chart.setAttribute("width", width);
    chart.setAttribute("height", height);
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    chart.replaceChildren();
    const clip = svg("clipPath", { id: "plot" }, svg("defs", {}, chart));
    svg("rect", { x: left, y: 0, width: right - left, height }, clip);

    for (let v = yMin; v <= yMax + yStep / 2; v += yStep) {
      svg("line", { class: "gridline", x1: left, x2: right, y1: round(Y(v)), y2: round(Y(v)) }, chart);
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
      traceRuns(decimate(displayed[key], key, t0, now, buckets), key, now, isStep, X, scale);
    const socRuns = runs("soc", S, true);
    svg("path", { class: "area", d: areaPath(socRuns, bottom) }, plot);
    svg("path", { class: "trace soc", d: linePath(socRuns) }, plot);
    svg("path", { class: "trace battery", d: linePath(runs("battery", Y, true)) }, plot);
    svg("path", { class: "trace ceiling", d: linePath(runs("ceiling", Y, true)) }, plot);
    if (projection) {
      const d = `M${round(X(projection.anchor))},${round(Y(projection.from))}L${round(X(projection.end))},${round(Y(projection.target))}`;
      svg("path", { class: "trace planned projection", d }, plot);
    }
    svg("path", { class: "trace power", d: linePath(runs("power", Y, true)) }, plot);

    const nowX = round(X(now));
    svg("line", { class: "now", x1: nowX, x2: nowX, y1: top, y2: bandY + 6 }, chart);

    this._geom = { left, right, top, bottom: bandY + 6, t0, t1, now, X, transitions, projection, series };
    if (this._cursor) {
      // Do not replace a pinned inspector's DOM or selection as the rolling
      // window moves. Its timestamp/value snapshot remains inspectable.
      if (this._pinned) {
        if (this._cursor.t >= t0 && this._cursor.t <= t1) this._drawCursor(this._cursor.t);
        else this._cursorLine = null;
        this._positionTip();
        return;
      }
      const t = clamp(this._cursor.t, t0, t1);
      this._setCursor(t, this._cursor.transition);
    }
  }

  _inspect(event) {
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
    this._pinned = false;
    this._cursorLine?.remove();
    this._cursorLine = null;
    if (this._els.tip.matches(":popover-open")) this._els.tip.hidePopover();
  }

  _drawCursor(t) {
    const g = this._geom;
    const x = round(g.X(t));
    this._cursorLine?.remove();
    this._cursorLine = svg("line", { class: "cursor", x1: x, x2: x, y1: g.top, y2: g.bottom }, this._els.chart);
  }

  _historyValue(parent, text, entityId) {
    if (!entityId) return el("span", "", parent, text);
    const value = el("button", "", parent, text);
    value.type = "button";
    value.title = "Open full history";
    value.addEventListener("click", () => {
      // Selecting/copying a reading must not also open a dialog.
      const selection = this.shadowRoot.getSelection?.() ?? window.getSelection();
      if (selection && !selection.isCollapsed) return;
      this._hideCursor();
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        bubbles: true,
        composed: true,
        detail: { entityId, view: "history", large: true },
      }));
    });
    return value;
  }

  _setCursor(t, transition) {
    const g = this._geom;
    const { tip } = this._els;
    const f = this._formats();
    this._cursor = { t, transition };
    this._drawCursor(t);
    tip.replaceChildren();
    el("div", "when", tip, f.exact.format(t));
    const row = (key, label, value) => {
      const line = el("div", "row", tip);
      el("i", `swatch ${key}`, line);
      const name = el("span", "", line, label);
      if (SERIES[key]?.description) name.title = SERIES[key].description;
      const cell = el("span", "", line);
      const source = key === "ceiling" || key === "planned" ? "status" : key;
      this._historyValue(cell, value, this._ids[source]);
    };
    if (t > g.now) {
      const p = g.projection;
      const v = p.from + ((t - p.anchor) / (p.end - p.anchor)) * (p.target - p.from);
      el("div", "muted", tip, "Plan, not an actuator floor");
      row("planned", SERIES.planned.label, this._formatValue("planned", Math.min(v, p.target)));
    } else {
      const mode = el("div", "muted", tip);
      this._historyValue(mode, transition
        ? `${modeLabel(transition.from)} → ${modeLabel(transition.to)}`
        : modeLabel(valueAt(g.series.status, t)), this._ids.status);
      for (const key of NUMERIC) row(key, SERIES[key].label, this._formatValue(key, valueAt(g.series[key], t)));
    }
    if (!tip.matches(":popover-open")) tip.showPopover();
    this._positionTip();
  }

  _positionTip() {
    const { chart, tip } = this._els;
    if (!tip.matches(":popover-open")) return;
    const width = tip.offsetWidth;
    const rect = chart.getBoundingClientRect();
    tip.style.left = `${clamp(rect.left + (rect.width - width) / 2, 8, Math.max(8, window.innerWidth - width - 8))}px`;
    const top = rect.bottom + 8 + tip.offsetHeight > window.innerHeight - 8 ? rect.top - tip.offsetHeight - 8 : rect.bottom + 8;
    tip.style.top = `${Math.max(8, top)}px`;
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, VictronChargingChart);
window.customCardFeatures = window.customCardFeatures || [];
if (!window.customCardFeatures.some((feature) => feature.type === TAG)) {
  window.customCardFeatures.push({
    type: TAG,
    name: "Victron grid input power chart",
    description: "Grid import, battery power, nominal input ceiling and SoC history with a planned input allowance.",
    configurable: false,
    // Chart-only feature for the genuine Mushroom grid-input composition.
    isSupported: (hass, context) => {
      const id = context?.entity_id;
      return typeof id === "string" && typeof hass?.states?.[id]?.attributes?.phase === "string";
    },
  });
}
