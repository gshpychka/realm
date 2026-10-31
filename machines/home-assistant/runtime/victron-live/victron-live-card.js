// Read-only Lovelace card drawing the Victron VRM "overview" layout: grid, inverter,
// AC loads and battery boxes joined by animated power paths.
//
// Every shape is an original vector primitive drawn here; no Victron/VRM/gui-v2
// asset is copied. The card has no dependencies, performs no API polling and
// calls no services: it only reads `hass.states` pushed by the frontend.
//
// Usage (all entity bindings are optional and default to DEFAULT_ENTITIES):
//   type: custom:victron-live-card
//   entities:
//     grid_power: sensor.grid_power

const CARD_TYPE = "victron-live-card";
const DASH = "—";

// Battery power is positive while charging. Grid power is positive while
// importing. Loads come from the Cerbo consumption sensor, not the MultiPlus
// output, so they include loads the inverter output does not see.
const DEFAULT_ENTITIES = Object.freeze({
  grid_power: "sensor.grid_power",
  grid_voltage: "sensor.multiplus_input_voltage_l1",
  grid_current: "sensor.multiplus_input_current_l1",
  grid_l1_power: "sensor.multiplus_input_power_l1",
  grid_present: "binary_sensor.city_power",
  inverter_state: "sensor.multiplus_state",
  inverter_connected: "binary_sensor.multiplus_connected",
  loads_power: "sensor.cerbo_consumption_power_l1",
  loads_l1_power: "sensor.cerbo_consumption_power_l1",
  loads_frequency: "sensor.multiplus_output_frequency_l1",
  battery_soc: "sensor.battery_charge",
  battery_power: "sensor.battery_power",
  battery_voltage: "sensor.battery_dc_bus_voltage",
  battery_current: "sensor.battery_dc_bus_current",
  battery_temperature: "sensor.battery_temperature",
});
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

// Sensor noise around zero should not animate a path or flip the battery label.
// The numeric value is still displayed exactly as reported.
const IDLE_WATTS = 10;

// Unit conversions to the base unit of each quantity. An absent unit is taken as
// the base unit; an unrecognised one renders as unknown instead of a wrong number.
const UNITS = Object.freeze({
  power: { W: 1, kW: 1e3, MW: 1e6 },
  voltage: { V: 1, mV: 1e-3, kV: 1e3 },
  current: { A: 1, mA: 1e-3 },
  frequency: { Hz: 1, kHz: 1e3 },
  percent: { "%": 1 },
});

// Colours sampled from the reference VRM screenshot.
const COLOR = Object.freeze({
  background: "#3c3c3c",
  lower: "#373737",
  border: "#4d4d4d",
  divider: "#4e4e4e",
  text: "#e8e8e8",
  muted: "#a8a8a8",
  blue: "#4a90d0",
  orange: "#f8a63a",
  grid: "#e2574c",
  ac: "#8bb86a",
  battery: "#b5ceec",
  flow: "#bfe0ff",
});

// Box sizes match the 1179x1015 reference; layouts only move the boxes and paths.
const BOX = Object.freeze({
  ac: { width: 340, height: 313, divider: 178 },
  inverter: { width: 298, height: 370, body: 271 },
  battery: { width: 340, height: 553, divider: 225 },
});

// Paths run from source to sink for positive power: grid -> inverter (import),
// inverter -> loads, inverter -> battery (charging).
const LAYOUTS = Object.freeze({
  wide: {
    width: 1179,
    height: 1015,
    grid: [32, 17],
    inverter: [440, 17],
    loads: [807, 17],
    battery: [32, 437],
    paths: {
      grid: [
        [371, 207],
        [442, 207],
      ],
      loads: [
        [736, 207],
        [808, 207],
      ],
      battery: [
        [594, 385],
        [594, 622],
        [371, 622],
      ],
    },
  },
  // Phones: grid and loads side by side, inverter and battery stacked below so
  // labels stay near their reference size after scaling to a 390px viewport.
  narrow: {
    width: 736,
    height: 1420,
    grid: [16, 16],
    inverter: [219, 409],
    loads: [380, 16],
    battery: [198, 851],
    paths: {
      grid: [
        [110, 328],
        [110, 540],
        [221, 540],
      ],
      loads: [
        [515, 540],
        [626, 540],
        [626, 328],
      ],
      battery: [
        [368, 777],
        [368, 852],
      ],
    },
  },
});
const NARROW_BELOW_PX = 720;

// Flow particles move at a constant speed with constant spacing. Their motion
// path extends under the boxes at both ends so short paths still read as flow.
const FLOW = Object.freeze({ speed: 110, spacing: 210, overrun: 60, length: 46 });

const FONT =
  'var(--victron-live-font, "Museo Sans Rounded", ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif)';

function translate([x, y]) {
  return `transform="translate(${x} ${y})"`;
}

function text(field, x, y, size, attributes = "") {
  return `<text data-field="${field}" x="${x}" y="${y}" font-size="${size}" ${attributes}>${DASH}</text>`;
}

function label(value, x, y, size, attributes = "") {
  return `<text x="${x}" y="${y}" font-size="${size}" ${attributes}>${value}</text>`;
}

// Box outline with the darker lower section below `divider`.
function frame(width, height, divider) {
  const r = 8;
  return `
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${r}" fill="${COLOR.background}"/>
    <path d="M1 ${divider} H${width - 1} V${height - 1 - r} Q${width - 1} ${height - 1} ${width - 1 - r} ${height - 1} H${1 + r} Q1 ${height - 1} 1 ${height - 1 - r} Z" fill="${COLOR.lower}"/>
    <line x1="1" y1="${divider}" x2="${width - 1}" y2="${divider}" stroke="${COLOR.divider}" stroke-width="2"/>
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${r}" fill="none" stroke="${COLOR.border}" stroke-width="2"/>`;
}

function pylonIcon() {
  return `<g transform="translate(30 27)" fill="none" stroke="${COLOR.grid}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 2 L5 46 M20 2 L35 46 M3 12 H37"/>
    <path d="M20 12 L13 31 L27 31 Z M13 31 L20 40 L27 31"/>
  </g>`;
}

function acIcon() {
  return `<g transform="translate(50 50)" fill="none" stroke="${COLOR.ac}" stroke-width="4" stroke-linecap="round">
    <circle r="21"/>
    <path d="M-11 2 C-7 -8 -3 -8 0 0 S7 8 11 -2"/>
  </g>`;
}

function batteryIcon() {
  return `<g transform="translate(34 27)" stroke="${COLOR.battery}" stroke-width="3.5" stroke-linejoin="round">
    <path d="M10 6 V1 H22 V6" fill="none"/>
    <rect x="2" y="6" width="28" height="40" rx="3" fill="none"/>
    <rect data-field="batteryLevel" x="7" y="41" width="18" height="0" rx="1" fill="${COLOR.battery}" stroke="none"/>
    <path data-field="batteryBolt" d="M19 13 L10 28 H17 L13 39 L23 23 H16 Z" fill="${COLOR.battery}" stroke-width="1.5"/>
  </g>`;
}

// An original side view of a spring: a trochoid split into one segment per
// turn. Each turn is drawn over a wider blue stroke so it visibly crosses the
// previous one, giving the coil its depth.
function coilIcon() {
  const turns = 4.25;
  const steps = 40;
  const points = [];
  for (let i = 0; i <= turns * steps; i++) {
    const t = Math.PI * 0.5 + (i / steps) * 2 * Math.PI;
    points.push([4.2 * t - 24 * Math.sin(t), 46 * Math.cos(t + 0.3)]);
  }
  const xs = points.map(([x]) => x);
  const offset = -(Math.min(...xs) + Math.max(...xs)) / 2;
  const segments = [];
  for (let start = 0; start < points.length - 1; start += steps / 2) {
    const slice = points.slice(start, start + steps / 2 + 1);
    segments.push(
      `M${slice.map(([x, y]) => `${(x + offset).toFixed(1)} ${y.toFixed(1)}`).join(" L")}`,
    );
  }
  return `<g transform="translate(149 80)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    ${segments
      .map(
        (d) =>
          `<path d="${d}" stroke="${COLOR.blue}" stroke-width="22"/><path d="${d}" stroke="#fff" stroke-width="12"/>`,
      )
      .join("")}
  </g>`;
}

function gridBox(origin) {
  const { width, height, divider } = BOX.ac;
  return `<g ${translate(origin)}>
    ${frame(width, height, divider)}
    ${pylonIcon()}
    ${text("gridTitle", 86, 63, 34)}
    ${text("gridPower", 25, 141, 48)}
    ${label("L1", 25, 233, 28)}
    ${text("gridVoltage", 182, 233, 28)}
    ${text("gridCurrent", 25, 279, 28)}
    ${text("gridL1Power", 182, 279, 28)}
  </g>`;
}

function loadsBox(origin) {
  const { width, height, divider } = BOX.ac;
  return `<g ${translate(origin)}>
    ${frame(width, height, divider)}
    ${acIcon()}
    ${label("AC Loads", 86, 63, 34)}
    ${text("loadsPower", 25, 141, 48)}
    ${label("L1", 25, 233, 28)}
    ${text("loadsL1Power", 182, 233, 28)}
    ${text("loadsFrequency", 25, 279, 28)}
  </g>`;
}

function inverterBox(origin) {
  const { width, height, body } = BOX.inverter;
  const r = 8;
  return `<g ${translate(origin)}>
    <rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="${r}" fill="${COLOR.background}"/>
    <path d="M1.5 ${body} V${1.5 + r} Q1.5 1.5 ${1.5 + r} 1.5 H${width - 1.5 - r} Q${width - 1.5} 1.5 ${width - 1.5} ${1.5 + r} V${body} Z" fill="${COLOR.blue}"/>
    <rect x="1.5" y="149" width="${width - 3}" height="8" fill="${COLOR.orange}"/>
    ${coilIcon()}
    <rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="${r}" fill="none" stroke="${COLOR.blue}" stroke-width="3"/>
    ${text("inverterState", width / 2, 331, 33, `text-anchor="middle" fill="${COLOR.blue}"`)}
  </g>`;
}

function batteryBox(origin) {
  const { width, height, divider } = BOX.battery;
  const rule = (y) =>
    `<line x1="25" y1="${y}" x2="${width - 25}" y2="${y}" stroke="${COLOR.divider}" stroke-width="2"/>`;
  return `<g ${translate(origin)}>
    ${frame(width, height, divider)}
    ${batteryIcon()}
    ${text("batteryTitle", 86, 63, 34)}
    ${text("batteryPower", 86, 110, 30, `fill="${COLOR.muted}"`)}
    ${text("batterySoc", 25, 188, 48)}
    ${label("Voltage", 25, 283, 28)}
    ${text("batteryVoltage", 182, 283, 28)}
    ${rule(322)}
    ${label("Current", 25, 378, 28)}
    ${text("batteryCurrent", 182, 378, 28)}
    ${rule(418)}
    ${label("Temperature", 25, 475, 28)}
    ${text("batteryTemperature", 25, 520, 28)}
  </g>`;
}

function polyline(points) {
  return `M${points.map(([x, y]) => `${x} ${y}`).join(" L")}`;
}

// The visible pipe is a wide border-coloured stroke with a background-coloured
// core, leaving two thin rails like the reference.
function pipe(points) {
  const d = polyline(points);
  return `<path d="${d}" stroke="${COLOR.border}" stroke-width="13"/><path d="${d}" stroke="${COLOR.background}" stroke-width="7"/>`;
}

function extendedMotion(points) {
  const extend = ([ax, ay], [bx, by]) => {
    const length = Math.hypot(bx - ax, by - ay);
    return [bx + ((bx - ax) / length) * FLOW.overrun, by + ((by - ay) / length) * FLOW.overrun];
  };
  const path = [extend(points[1], points[0]), ...points, extend(points.at(-2), points.at(-1))];
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  }
  return { d: polyline(path), length };
}

// SMIL animateMotion carries a comet-shaped particle (bright head, fading tail)
// along the path. Negative begin offsets space the particles evenly; reversed
// flow swaps the key points and turns each particle around.
function particles(points, direction, gradient) {
  if (direction === 0) return "";
  const { d, length } = extendedMotion(points);
  const count = Math.max(1, Math.round(length / FLOW.spacing));
  const duration = length / FLOW.speed;
  const keyPoints = direction > 0 ? "0;1" : "1;0";
  const rotate = direction > 0 ? "auto" : "auto-reverse";
  let result = "";
  for (let i = 0; i < count; i++) {
    const begin = -((i * duration) / count).toFixed(3);
    result += `<rect x="${-FLOW.length}" y="-3.5" width="${FLOW.length}" height="7" fill="url(#${gradient})">
      <animateMotion path="${d}" dur="${duration.toFixed(3)}s" begin="${begin}s" repeatCount="indefinite" keyPoints="${keyPoints}" keyTimes="0;1" calcMode="linear" rotate="${rotate}"/>
    </rect>`;
  }
  return result;
}

function isUnknownState(state) {
  return state === undefined || state === "unknown" || state === "unavailable" || state === "";
}

// Returns the value in the quantity's base unit, or null when it is unknown,
// unavailable, non-finite or in an unrecognised unit. Never substitutes zero.
function numeric(stateObj, quantity) {
  if (!stateObj || isUnknownState(stateObj.state)) return null;
  const value = Number(stateObj.state);
  if (stateObj.state.trim() === "" || !Number.isFinite(value)) return null;
  const unit = stateObj.attributes?.unit_of_measurement;
  if (quantity === undefined || unit === undefined || unit === null) return value;
  const factor = UNITS[quantity][unit];
  return factor === undefined ? null : value * factor;
}

function fixed(value, digits, unit) {
  if (value === null) return DASH;
  const rounded = value.toFixed(digits);
  // Avoid "-0" from tiny negative readings.
  return `${Number(rounded) === 0 ? (0).toFixed(digits) : rounded} ${unit}`;
}

// VRM shows watts up to 10 kW and kilowatts with two decimals above that.
function power(watts) {
  if (watts === null) return DASH;
  return Math.abs(watts) >= 10000 ? fixed(watts / 1000, 2, "kW") : fixed(watts, 0, "W");
}

function current(amps) {
  return amps !== null && Math.abs(amps) >= 100 ? fixed(amps, 0, "A") : fixed(amps, 1, "A");
}

function direction(watts, enabled = true) {
  if (!enabled || watts === null || Math.abs(watts) < IDLE_WATTS) return 0;
  return Math.sign(watts);
}

function humanize(state) {
  const words = state.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

class VictronLiveCard extends HTMLElement {
  static getStubConfig() {
    return {};
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entities = DEFAULT_ENTITIES;
    this._layout = null;
    this._fields = new Map();
    this._directions = { grid: null, loads: null, battery: null };
    this._seen = null;
    this._gradient = `victron-live-flow-${Math.random().toString(36).slice(2)}`;
    this._motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this._onMotionChange = () => this._applyMotionPreference();
    this._resize = new ResizeObserver(([entry]) => this._chooseLayout(entry.contentRect.width));
  }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Invalid configuration");
    for (const key of Object.keys(config)) {
      if (key !== "type" && key !== "entities") throw new Error(`Unknown option: ${key}`);
    }
    const overrides = config.entities ?? {};
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error("entities must be a mapping");
    }
    for (const [key, entityId] of Object.entries(overrides)) {
      if (!(key in DEFAULT_ENTITIES)) throw new Error(`Unknown entity binding: ${key}`);
      if (typeof entityId !== "string" || !ENTITY_ID.test(entityId)) {
        throw new Error(`Invalid entity id for ${key}`);
      }
    }
    this._entities = Object.freeze({ ...DEFAULT_ENTITIES, ...overrides });
    this._seen = null;
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  getCardSize() {
    return 12;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  connectedCallback() {
    this._resize.observe(this);
    this._motion.addEventListener("change", this._onMotionChange);
    if (!this._layout) this._chooseLayout(this.clientWidth || LAYOUTS.wide.width);
  }

  disconnectedCallback() {
    this._resize.disconnect();
    this._motion.removeEventListener("change", this._onMotionChange);
  }

  _chooseLayout(width) {
    if (width <= 0) return;
    const layout = width < NARROW_BELOW_PX ? "narrow" : "wide";
    if (layout === this._layout) return;
    this._layout = layout;
    this._render();
  }

  _render() {
    const layout = LAYOUTS[this._layout];
    // The template contains only constants; entity values are written later
    // through textContent, never parsed as markup.
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card, .card {
          display: block;
          overflow: hidden;
          background: ${COLOR.background};
          border-radius: var(--ha-card-border-radius, 12px);
        }
        svg { display: block; width: 100%; height: auto; }
        text { font-family: ${FONT}; }
        /* CSS fill would override the coloured texts' fill attributes. */
        text:not([fill]) { fill: ${COLOR.text}; }
      </style>
      <ha-card class="card">
        <svg viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="Victron energy overview" text-rendering="geometricPrecision">
          <defs>
            <linearGradient id="${this._gradient}">
              <stop offset="0" stop-color="${COLOR.flow}" stop-opacity="0"/>
              <stop offset="0.7" stop-color="${COLOR.flow}" stop-opacity="0.85"/>
              <stop offset="1" stop-color="#ffffff"/>
            </linearGradient>
          </defs>
          <g fill="none">
            ${Object.values(layout.paths).map(pipe).join("")}
          </g>
          <g data-flow="grid"></g>
          <g data-flow="loads"></g>
          <g data-flow="battery"></g>
          ${gridBox(layout.grid)}
          ${loadsBox(layout.loads)}
          ${batteryBox(layout.battery)}
          ${inverterBox(layout.inverter)}
        </svg>
      </ha-card>`;
    this._svg = this.shadowRoot.querySelector("svg");
    this._fields = new Map(
      [...this.shadowRoot.querySelectorAll("[data-field]")].map((node) => [
        node.dataset.field,
        node,
      ]),
    );
    this._flows = Object.fromEntries(
      [...this.shadowRoot.querySelectorAll("[data-flow]")].map((node) => [node.dataset.flow, node]),
    );
    this._directions = { grid: null, loads: null, battery: null };
    this._seen = null;
    this._applyMotionPreference();
    this._update();
  }

  // Reduced motion freezes the particles in place; their comet shape still
  // shows the direction of flow.
  _applyMotionPreference() {
    if (!this._svg) return;
    if (this._motion.matches) {
      this._svg.pauseAnimations();
      this._svg.setCurrentTime(0);
    } else {
      this._svg.unpauseAnimations();
    }
  }

  _set(field, value) {
    const node = this._fields.get(field);
    if (node && node.textContent !== value) node.textContent = value;
  }

  _flow(name, value) {
    if (this._directions[name] === value) return;
    this._directions[name] = value;
    // Particle markup is built from constants and computed numbers only.
    this._flows[name].innerHTML = particles(
      LAYOUTS[this._layout].paths[name],
      value,
      this._gradient,
    );
    if (this._motion.matches) this._svg.setCurrentTime(0);
  }

  _update() {
    if (!this._hass || !this._svg) return;
    const states = this._hass.states;
    const objects = Object.values(this._entities).map((id) => states[id]);
    // HA replaces a state object whenever it changes, so identity is enough to
    // skip unrelated pushes. last_updated is deliberately not a staleness signal:
    // an unchanged, connected value is still current.
    if (this._seen && objects.every((object, i) => object === this._seen[i])) return;
    this._seen = objects;

    const entity = (key) => states[this._entities[key]];
    const value = (key, quantity) => numeric(entity(key), quantity);

    const connected = entity("inverter_connected")?.state !== "off";
    const gridPresent = entity("grid_present")?.state !== "off";

    const gridPower = value("grid_power", "power");
    this._set("gridTitle", gridPresent ? "Grid" : "Grid lost");
    this._set("gridPower", power(gridPower));
    this._set("gridVoltage", fixed(value("grid_voltage", "voltage"), 0, "V"));
    this._set("gridCurrent", current(value("grid_current", "current")));
    this._set("gridL1Power", power(value("grid_l1_power", "power")));

    const loadsPower = value("loads_power", "power");
    this._set("loadsPower", power(loadsPower));
    this._set("loadsL1Power", power(value("loads_l1_power", "power")));
    this._set("loadsFrequency", fixed(value("loads_frequency", "frequency"), 1, "Hz"));

    const stateObj = entity("inverter_state");
    let inverterState = DASH;
    if (!connected) {
      inverterState = "Disconnected";
    } else if (stateObj && !isUnknownState(stateObj.state)) {
      // formatEntityState applies the integration's enum translations when it
      // has them; otherwise it returns the raw state, which is humanised.
      const formatted = this._hass.formatEntityState?.(stateObj) ?? stateObj.state;
      inverterState = formatted === stateObj.state ? humanize(formatted) : formatted;
    }
    this._set("inverterState", inverterState);

    const batteryPower = value("battery_power", "power");
    const batteryDirection = direction(batteryPower);
    this._set(
      "batteryTitle",
      batteryPower === null ? "Battery" : ["Discharging", "Idle", "Charging"][batteryDirection + 1],
    );
    this._set("batteryPower", power(batteryPower));
    const soc = value("battery_soc", "percent");
    this._set("batterySoc", fixed(soc, 1, "%"));
    this._set("batteryVoltage", fixed(value("battery_voltage", "voltage"), 2, "V"));
    this._set("batteryCurrent", current(value("battery_current", "current")));
    const temperature = entity("battery_temperature");
    this._set(
      "batteryTemperature",
      fixed(numeric(temperature), 0, temperature?.attributes?.unit_of_measurement ?? "°C"),
    );

    const bolt = this._fields.get("batteryBolt");
    bolt.style.display = batteryDirection > 0 ? "" : "none";
    const level = this._fields.get("batteryLevel");
    const fill =
      batteryDirection > 0 || soc === null ? 0 : (Math.min(Math.max(soc, 0), 100) / 100) * 30;
    level.setAttribute("y", String(41 - fill));
    level.setAttribute("height", String(fill));

    this._flow("grid", direction(gridPower, connected && gridPresent));
    this._flow("loads", direction(loadsPower, connected));
    this._flow("battery", direction(batteryPower, connected));
  }
}

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, VictronLiveCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TYPE,
    name: "Victron live overview",
    description: "Read-only Victron VRM-style grid, inverter, loads and battery overview.",
  });
}
