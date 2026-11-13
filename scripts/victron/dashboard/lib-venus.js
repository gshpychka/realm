// Derived from www/lib-venus.js of jayjojayson/hass-victron-vrm-api 2.0
// (commit 017c7dc0c6956c6602c5678f2b339a514257a1e1), Apache-2.0.
// Modified for the standalone victron-energy-card; license and attribution are in victron-energy-card.js.
//
// Rendering library: card skeleton, boxes, anchors, connection lines, flow
// animation and history sparklines with hover/tap inspection. It reads
// hass.states and the recorder history REST endpoint only; it never calls
// services.

/* A flow moves only when its signal is a finite number outside ±FLOW_DEADBAND.
   Zero, missing, unknown and unavailable signals stop it (upstream threshold). */
const FLOW_DEADBAND = 0.5;

/* The editor offers 0–3 anchors per side; larger YAML values are clamped. */
const MAX_ANCHORS_PER_SIDE = 3;

/* Ball radius at a card width of 1000 CSS pixels. */
const DEFAULT_BALL_SIZE = 4;
export const MIN_BALL_SIZE = 0.5;
export const MAX_BALL_SIZE = 20;

/* Shown for configured entities that are missing, unknown or unavailable. */
const ABSENT = "—";

export const HISTORY_HOURS = 24;

const BOX_ID = /^[1-3]-[1-4]$/;
const ANCHOR = /^([LTBR])-(\d+)$/;
const LINK_END = /^([1-3]-[1-4])_([LTBR]-\d+)$/;
const ANCHOR_ID = /^([1-3]-[1-4])_([LTBR]-\d+)$/;

/************************************************/
/* Default configuration                        */
/************************************************/

/**
 * The owner's Victron system as published by the Cerbo GX through Home
 * Assistant's MQTT integration. The card itself is integration-agnostic: these
 * are ordinary entity ids and any entity from any integration can replace them.
 *
 * Flow sign conventions (a link animates from `start` towards `end`, `inv`
 * reverses that):
 *   - grid: input power, import positive  → grid → inverter
 *   - battery: DC current, charge positive → inverter → battery (inv)
 *   - loads: consumption positive          → inverter → loads (inv)
 */
export function getDefaultConfig() {
    return {
        theme: "auto",
        param: {
            boxCol1: 2,
            boxCol2: 1,
            boxCol3: 1,
            ballSize: DEFAULT_BALL_SIZE,
        },
        styles: {
            header: "auto",
            sensor: "auto",
            sensor2: "auto",
            footer: "auto",
        },
        devices: {
            "1-1": {
                icon: "mdi:transmission-tower",
                name: "Grid",
                entity: "sensor.multiplus_input_power_l1",
                entity2: "sensor.multiplus_input_voltage_l1",
                footerEntity1: "sensor.multiplus_input_current_l1",
                graph: true,
                anchors: "R-1",
                link: {
                    "1": {
                        start: "R-1",
                        end: "2-1_L-1",
                        entity: "sensor.multiplus_input_power_l1",
                    },
                },
            },
            "1-2": {
                icon: "mdi:battery-charging",
                name: "Battery",
                entity: "sensor.battery_charge",
                entity2: "sensor.battery_power",
                footerEntity1: "sensor.battery_dc_bus_current",
                footerEntity2: "sensor.battery_dc_bus_voltage",
                control_entity: "number.cerbo_ess_max_charge_current",
                gauge: true,
                graph: true,
                anchors: "R-1",
                link: {
                    "1": {
                        start: "R-1",
                        end: "2-1_B-1",
                        entity: "sensor.battery_dc_bus_current",
                        inv: true,
                    },
                },
            },
            "2-1": {
                icon: "mdi:sine-wave",
                name: "MultiPlus",
                entity: "sensor.multiplus_state",
                entity2: "sensor.multiplus_output_power_l1",
                control_entity: "select.multiplus",
                anchors: "L-1, B-1, R-1",
            },
            "3-1": {
                icon: "mdi:home-lightning-bolt",
                name: "Loads",
                entity: "sensor.cerbo_consumption_power_l1",
                entity2: "sensor.multiplus_output_frequency_l1",
                graph: true,
                anchors: "L-1",
                link: {
                    "1": {
                        start: "L-1",
                        end: "2-1_R-1",
                        entity: "sensor.cerbo_consumption_power_l1",
                        inv: true,
                    },
                },
            },
        },
    };
}

/**
 * A configuration without a `devices` key gets the complete default
 * configuration underneath it (explicit top-level keys win). A configuration
 * with `devices` — even an empty one — is used exactly as written: no default
 * box, entity or link is injected.
 */
export function withDefaults(config) {
    if (Object.prototype.hasOwnProperty.call(config, "devices")) {
        return { ...config, devices: config.devices ?? {} };
    }
    const defaults = getDefaultConfig();
    return {
        ...defaults,
        ...config,
        param: { ...defaults.param, ...config.param },
        styles: { ...defaults.styles, ...config.styles },
        devices: defaults.devices,
    };
}

/************************************************/
/* Small helpers and input validation           */
/************************************************/

/* Number of boxes per column (same bounds as the editor) */
export function getBoxCount(param, col) {
    const max = col === 2 ? 2 : 4;
    const raw = parseInt(param?.[`boxCol${col}`], 10);
    if (isNaN(raw)) return 1;
    return Math.min(Math.max(raw, 1), max);
}

/* "true"/true → true (YAML and the editor sometimes deliver strings) */
export function isTrue(value) {
    return value === true || value === "true";
}

/* Configured box ids that exist with the current column counts */
export function visibleBoxIds(config) {
    return Object.keys(config.devices || {}).filter((boxId) =>
        BOX_ID.test(boxId) &&
        parseInt(boxId[2], 10) <= getBoxCount(config.param, parseInt(boxId[0], 10)) &&
        config.devices[boxId] && typeof config.devices[boxId] === "object"
    );
}

/* Links of a box as [linkId, link] pairs with validated geometry */
function validLinks(device) {
    const links = device?.link;
    if (!links || typeof links !== "object") return [];
    return Object.entries(links).filter(([, link]) =>
        link && typeof link === "object" &&
        typeof link.start === "string" && ANCHOR.test(link.start) &&
        typeof link.end === "string" && LINK_END.test(link.end)
    );
}

/**
 * Parse an anchor string such as "L-1, B-2, R-1". Unknown parts are ignored,
 * a side listed twice keeps its larger count, counts are clamped to 1–3.
 */
export function parseAnchors(anchorsValue) {
    if (!anchorsValue) return [];
    const perSide = new Map();
    String(anchorsValue)
        .split(/\s*,\s*/)
        .forEach((part) => {
            const match = ANCHOR.exec(part.trim());
            if (!match) return;
            const qty = Math.min(parseInt(match[2], 10), MAX_ANCHORS_PER_SIDE);
            if (qty < 1) return;
            perSide.set(match[1], Math.max(perSide.get(match[1]) || 0, qty));
        });
    return Array.from(perSide, ([type, qty]) => ({ type, qty }));
}

/* Font size: number → px, "<number><px|em|rem|%>" unchanged, anything else ignored */
function toFontSize(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return `${value}px`;
    const text = String(value ?? "").trim();
    if (/^\d+(\.\d+)?$/.test(text)) return `${text}px`;
    if (/^\d+(\.\d+)?(px|em|rem|%)$/.test(text)) return text;
    return "";
}

/**
 * Colours end up in a <style> element and SVG attributes, so only plain colour
 * syntax is accepted: hex, a colour keyword, rgb()/hsl() with numeric
 * arguments or a CSS custom property. Anything else returns "" (= default).
 */
export function safeColor(value) {
    const text = String(value ?? "").trim();
    return /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|rgba|hsl|hsla)\([-\d.%\s,\/a-z]*\)|var\(--[\w-]+\))$/i.test(text)
        ? text
        : "";
}

export function ballSize(param) {
    const value = Number(param?.ballSize);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_BALL_SIZE;
    return Math.min(Math.max(value, MIN_BALL_SIZE), MAX_BALL_SIZE);
}

/* Escape text for HTML text and double-quoted attribute values */
export function esc(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function entityId(value) {
    return typeof value === "string" ? value.trim() : "";
}

function isAbsent(stateObj) {
    return !stateObj ||
        stateObj.state === undefined || stateObj.state === null || stateObj.state === "" ||
        stateObj.state === "unknown" || stateObj.state === "unavailable";
}

/**
 * Finite number of an entity state, or null when it is missing, unknown,
 * unavailable or not numeric. Unavailable is never treated as zero.
 */
export function numericState(stateObj) {
    if (isAbsent(stateObj)) return null;
    const text = String(stateObj.state).trim();
    if (text === "") return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

/**
 * Value and unit of an entity, formatted by Home Assistant when available
 * (display precision, locale, translated states). Absent states show "—".
 */
export function formatEntity(hass, id) {
    if (!id) return { value: "", unit: "" };
    const stateObj = hass?.states?.[id];
    if (isAbsent(stateObj)) return { value: ABSENT, unit: "" };
    const unit = stateObj.attributes?.unit_of_measurement || "";
    let value = stateObj.state;
    if (typeof hass.formatEntityState === "function") {
        try {
            let formatted = hass.formatEntityState(stateObj);
            if (typeof formatted === "string") {
                if (unit && formatted.endsWith(unit)) {
                    formatted = formatted.slice(0, -unit.length).trim();
                }
                value = formatted;
            }
        } catch (e) {
            // raw state stays the fallback
        }
    }
    return { value, unit };
}

/************************************************/
/* Per-card render state                        */
/************************************************/

// Keyed by the card's container element, so every card instance (dashboard,
// editor preview) owns its own animations and drawn graphs.
const perCard = new WeakMap();

function getState(appendTo) {
    if (!perCard.has(appendTo)) {
        perCard.set(appendTo, {
            pathControls: new Map(),
            dashboardOldWidth: undefined,
            mustRedrawLine: true,
            lineRafId: null,
            graphDrawn: new Map(),
            hass: null,
        });
    }
    return perCard.get(appendTo);
}

/************************************************/
/* Card skeleton                                */
/************************************************/
export function baseRender(appendTo) {

    appendTo.innerHTML = `
        <div id="dashboard" class="dashboard">
            <svg id="svg_container" class="line" viewBox="0 0 1000 600" preserveAspectRatio="none" width="100%" height="100%">
                <defs>
                    <radialGradient id="gradientDark" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#ffffff" stop-opacity="1"></stop>
                        <stop offset="90%" stop-color="#ffffff" stop-opacity="0"></stop>
                    </radialGradient>
                    <radialGradient id="gradientLight" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#000000" stop-opacity="1"></stop>
                        <stop offset="90%" stop-color="#000000" stop-opacity="0"></stop>
                    </radialGradient>
                </defs>
                <g id="path_container" class="balls"></g>
                <g id="circ_container" class="lines"></g>
            </svg>
            <div id="column-1" class="column column-1"></div>
            <div id="column-2" class="column column-2"></div>
            <div id="column-3" class="column column-3"></div>
        </div>
    `;

}

/**********************************/
/* Boxes: quantity per column     */
/**********************************/
export function addBox(col1, col2, col3, appendTo) {

    [col1, col2, col3].forEach((count, columnIndex) => {
        const column = appendTo.querySelector(`#dashboard > #column-${columnIndex + 1}`);
        if (!column) return;

        column.style.gap = count === 3 ? "5%" : count === 2 ? "10%" : "0";

        for (let i = 1; i <= count; i++) {
            const id = `${columnIndex + 1}-${i}`;

            const content = document.createElement("div");
            content.id = `content_${id}`;
            content.className = "content";

            const graph = document.createElement("div");
            graph.id = `graph_${id}`;
            graph.className = "graph";

            const gauge = document.createElement("div");
            gauge.id = `gauge_${id}`;
            gauge.className = "gauge";
            gauge.style.height = "0px";

            const box = document.createElement("div");
            box.id = `box_${id}`;
            box.className = "box";
            box.appendChild(graph);
            box.appendChild(gauge);
            box.appendChild(content);
            column.appendChild(box);
        }
    });
}

/****************************************/
/* Connection anchors of every box      */
/****************************************/
export function addAnchors(config, appendTo) {
    for (const boxId of visibleBoxIds(config)) {
        parseAnchors(config.devices[boxId].anchors).forEach(({ type, qty }) => {
            creatAnchors(boxId, qty, type, appendTo);
        });
    }
}

function creatAnchors(boxId, numAnchors, type, appendTo) {
    const box = appendTo.querySelector(`#dashboard > #column-${boxId[0]} > #box_${boxId}`);
    if (!box) return;

    for (let i = 0; i < numAnchors; i++) {
        const anchor = document.createElement("div");
        anchor.className = `anchor anchor-${type}`;
        anchor.id = `anchor_${boxId}_${type}-${i + 1}`;

        // evenly spread along the side
        const positionPercent = ((i + 1) / (numAnchors + 1)) * 100;
        if (type === "T" || type === "B") anchor.style.left = `${positionPercent}%`;
        else anchor.style.top = `${positionPercent}%`;

        box.appendChild(anchor);
    }
}

/**********************************************/
/* Box contents                               */
/**********************************************/

// "auto" font sizes scale linearly with the box width; the coefficients are
// upstream's, separately for the wider middle column and the outer columns.
const AUTO_FONT = {
    header:  { middle: [0.0693, 1.9854], outer: [0.0945, 2.209] },
    sensor:  { middle: [0.1065, 8.7929], outer: [0.1452, 9.0806] },
    sensor2: { middle: [0.0693, 1.9854], outer: [0.0945, 2.209] },
    footer:  { middle: [0.0803, -2.438], outer: [0.1095, -2.1791] },
};
const MIN_AUTO_FONT = { header: 12, sensor: 18, sensor2: 13, footer: 12 };

function fontCss(styles, zone, boxId, width) {
    const setting = styles[zone];
    if (!setting) return "";
    if (setting === "auto") {
        const [a, b] = AUTO_FONT[zone][boxId[0] === "2" ? "middle" : "outer"];
        const minimum = MIN_AUTO_FONT[zone];
        let size = Math.max(Math.round(a * width + b), minimum);
        if (zone === "sensor" && width < 140) size = minimum;
        return `font-size: ${size}px;`;
    }
    const size = toFontSize(setting);
    return size ? `font-size: ${size};` : "";
}

const styleAttr = (css) => (css ? ` style="${esc(css)}"` : "");
const valueHtml = (cls, formatted, css = "") =>
    `<div class="${cls}"${styleAttr(css)}>${esc(formatted.value)}<div class="boxUnit">${esc(formatted.unit)}</div></div>`;

export function fillBox(config, isDark, hass, appendTo, history, historyVersion) {

    const devices = config.devices || {};
    const styles = config.styles && typeof config.styles === "object" ? config.styles : {};

    // the line drawing frame applies flow directions with the latest hass
    getState(appendTo).hass = hass;

    for (const boxId of visibleBoxIds(config)) {

        const device = devices[boxId];

        const divGauge = appendTo.querySelector(`#dashboard > #column-${boxId[0]} > #box_${boxId} > #gauge_${boxId}`);
        const innerContent = appendTo.querySelector(`#dashboard > #column-${boxId[0]} > #box_${boxId} > #content_${boxId}`);
        if (!innerContent || !divGauge) continue;

        const mainId = entityId(device.entity);
        const width = innerContent.offsetWidth;

        if (isTrue(device.graph) && mainId) creatGraph(boxId, mainId, isDark, appendTo, config, history, historyVersion);

        const pct = isTrue(device.gauge) ? numericState(hass.states?.[mainId]) : null;
        divGauge.style.height = pct === null ? "0px" : `${Math.min(Math.max(pct, 0), 100)}%`;

        let addHeaderEntity = "";
        const headerId = entityId(device.headerEntity);
        if (headerId) addHeaderEntity = valueHtml("headerEntity", formatEntity(hass, headerId));

        let addEntity2 = "";
        const entity2Id = entityId(device.entity2);
        if (entity2Id) addEntity2 = valueHtml("boxSensor2", formatEntity(hass, entity2Id), fontCss(styles, "sensor2", boxId, width));

        // Footer: 1 to 3 configured values, layout and alignment per box
        let addFooter = "";
        const footerEntities = [device.footerEntity1, device.footerEntity2, device.footerEntity3].map(entityId).filter(Boolean);
        if (footerEntities.length) {
            const layout = device.footerLayout === "vertical" ? "vertical" : "horizontal";
            const align = ["left", "center", "right"].includes(device.footerAlign) ? device.footerAlign : "center";
            const justify = { left: "flex-start", center: "center", right: "flex-end" }[align];

            const footerCss = [fontCss(styles, "footer", boxId, width)];
            let cellCss = "";
            if (layout === "vertical") {
                footerCss.push(`flex-direction: column; align-items: ${justify}; gap: 2px; left: 0; box-sizing: border-box; padding: 0 6%;`);
                cellCss = `width: auto; justify-content: ${justify};`;
            } else if (align !== "center" || footerEntities.length < 3) {
                // fewer than 3 values or left/right: cells as wide as their content
                footerCss.push(`justify-content: ${justify}; left: 0; box-sizing: border-box; padding: 0 6%; gap: 8%;`);
                cellCss = `width: auto; justify-content: ${justify};`;
            }
            // horizontal + centred + 3 values = upstream default (3 equal cells)

            const cells = footerEntities.map((id) => valueHtml("footerCell", formatEntity(hass, id), cellCss)).join("");
            addFooter = `<div class="boxFooter footer-${layout}"${styleAttr(footerCss.join(" ").trim())}>${cells}</div>`;
        }

        const icon = typeof device.icon === "string" && device.icon ? `<ha-icon icon="${esc(device.icon)}" class="boxIcon"></ha-icon>` : "";

        const html = `
            <div class="boxHeader"${styleAttr(fontCss(styles, "header", boxId, width))}>
                ${icon}
                <div class="boxTitle">${esc(device.name)}</div>
                ${addHeaderEntity}
            </div>
            ${valueHtml("boxSensor1", formatEntity(hass, mainId), fontCss(styles, "sensor", boxId, width))}
            ${addEntity2}
            ${addFooter}
        `;

        // set hass runs on every state change in HA → only rewrite on change
        if (innerContent._vrmHtml !== html) {
            innerContent._vrmHtml = html;
            innerContent.innerHTML = html;
        }

        // Tap target: control_entity when configured, otherwise the reading.
        // Both open Home Assistant's own more-info dialog; nothing is written here.
        const target = entityId(device.control_entity) || mainId;
        innerContent.dataset.entity = target;
        if (target) {
            innerContent.setAttribute("role", "button");
            innerContent.tabIndex = 0;
        } else {
            innerContent.removeAttribute("role");
            innerContent.removeAttribute("tabindex");
        }

        if (!innerContent._vrmListener) {
            innerContent._vrmListener = true;
            const open = () => {
                const id = innerContent.dataset.entity;
                if (!id) return;
                innerContent.dispatchEvent(new CustomEvent("hass-more-info", {
                    bubbles: true,
                    composed: true,
                    detail: { entityId: id },
                }));
            };
            innerContent.addEventListener("click", open);
            innerContent.addEventListener("keydown", (ev) => {
                if (ev.key !== "Enter" && ev.key !== " ") return;
                ev.preventDefault();
                open();
            });
        }
    }
}

/**********************************************/
/* History sparkline                          */
/**********************************************/

/* Inspection retains every held value; drawing preserves per-pixel extrema and gaps. */

const SVG_NS = "http://www.w3.org/2000/svg";
/* viewBox size; the path is decimated to one min/max column per width unit */
const GRAPH_W = 500;
const GRAPH_H = 100;
/* keeps the 3-unit stroke inside the viewBox at the extremes */
const GRAPH_PAD = 1.5;
/* Raised while a tooltip is visible so it paints above the box texts
   (they share z-index 2 with the graph and come later in the DOM). */
const INSPECT_Z_INDEX = "4";

/* Inspection events stay inside the graph. */
const CONTAINED_EVENTS = [
    "pointerdown", "pointermove", "pointerup", "pointercancel", "mousedown", "mouseup",
    "touchstart", "touchmove", "touchend", "touchcancel", "click", "dblclick", "contextmenu", "action",
];

/* points array → { start, end } (ms) of the window it was fetched for */
const historyWindows = new WeakMap();
/** The fetched interval, in epoch milliseconds. */
export function getHistoryWindow(points) {
    const window = historyWindows.get(points);
    return window ? { ...window } : null;
}
/* graph div → its inspector view (elements, plotted series, active inspection) */
const inspectors = new WeakMap();

function creatGraph(boxId, mainId, isDark, appendTo, config, history, historyVersion) {

    const state = getState(appendTo);
    const customColor = safeColor(config.colors?.history);
    const graphKey = `${mainId}#${historyVersion}#${customColor}#${isDark}`;
    if (state.graphDrawn.get(boxId) === graphKey) return;

    const divGraph = appendTo.querySelector(`#dashboard > #column-${boxId[0]} > #box_${boxId} > #graph_${boxId}`);
    if (!divGraph) return;
    state.graphDrawn.set(boxId, graphKey);

    const points = history?.get(mainId);
    const plot = Array.isArray(points) ? plotHistory(points) : null;
    if (!plot) {
        clearGraph(divGraph);
        return;
    }

    const color = customColor || (isDark ? "#ffffff" : "#000000");
    const opacity = customColor ? 0.9 : 0.47;

    const view = graphView(divGraph);
    view.appendTo = appendTo;
    if (view.entity !== mainId) view.active = null;
    view.entity = mainId;
    view.plot = plot;

    // colours come from safeColor or constants and go through the DOM API
    view.line.setAttribute("stroke", color);
    view.line.setAttribute("stroke-opacity", String(opacity));
    view.line.setAttribute("d", plot.path);
    if (plot.zeroY === null) {
        view.zero.removeAttribute("d");
    } else {
        // signed series (e.g. import/export): faint zero reference
        view.zero.setAttribute("d", `M0,${round2(plot.zeroY)}H${GRAPH_W}`);
        view.zero.setAttribute("stroke", color);
    }
    view.cross.style.borderLeftColor = color;
    view.dot.style.backgroundColor = color;
    view.color = color;
    view.tip.style.background = isDark ? "rgba(28, 28, 28, 0.94)" : "rgba(255, 255, 255, 0.96)";
    view.tip.style.color = isDark ? "#ffffff" : "#484848";
    view.dot.style.boxShadow = `0 0 0 2px ${isDark ? "#1c1c1c" : "#ffffff"}`;
    divGraph.style.cursor = "crosshair";

    // a pinned or hovered time keeps its place across history refreshes
    if (view.active && view.active.time < plot.start) view.active = null;
    renderInspection(view);
}

/* No history (or none any more): drop the drawing and all inspector state */
function clearGraph(divGraph) {
    inspectors.delete(divGraph);
    divGraph.replaceChildren();
    divGraph.style.zIndex = "";
    divGraph.style.cursor = "";
}

/** Held history values, unavailable intervals and time coordinates. */
function plotHistory(points) {
    let rows = points.filter((p) => p && p.time instanceof Date && !isNaN(p.time.getTime()));
    for (let i = 1; i < rows.length; i++) {
        if (rows[i].time < rows[i - 1].time) {
            rows = rows.slice().sort((a, b) => a.time - b.time);
            break;
        }
    }
    const n = rows.length;
    if (!n) return null;

    const t = new Float64Array(n);
    const v = new Array(n);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
        t[i] = rows[i].time.getTime();
        const value = typeof rows[i].value === "number" && Number.isFinite(rows[i].value) ? rows[i].value : null;
        v[i] = value;
        if (value !== null) {
            if (value < lo) lo = value;
            if (value > hi) hi = value;
        }
    }
    if (lo === Infinity) return null;
    // constant series: a centred flat line
    if (lo === hi) {
        lo -= 1;
        hi += 1;
    }

    const fetched = historyWindows.get(points);
    const start = fetched ? fetched.start : t[0];
    let end = fetched ? fetched.end : Math.max(Date.now(), t[n - 1]);
    if (end <= start) end = start + 1;

    const span = end - start;
    const xOf = (time) => Math.min(Math.max((time - start) / span, 0), 1) * GRAPH_W;
    const yOf = (value) => GRAPH_PAD + ((hi - value) / (hi - lo)) * (GRAPH_H - 2 * GRAPH_PAD);

    // Decimation: consecutive held values starting in the same column are
    // summarised as first → min → max → last, so a 24 h history of a fast
    // sensor stays at most a few commands per column.
    const parts = [];
    let acc = null;
    let joined = false; // the next run continues the previous one (no gap between)
    const flush = () => {
        if (!acc) return;
        parts.push(`${acc.move ? "M" : "L"}${round2(acc.xStart)},${round2(acc.first)}`);
        if (acc.count > 1) {
            const jumpX = round2(acc.xLast);
            parts.push(`H${jumpX}V${round2(acc.min)}V${round2(acc.max)}V${round2(acc.last)}`);
        }
        parts.push(`H${round2(acc.xEnd)}`);
        acc = null;
    };

    for (let i = 0; i < n; i++) {
        const from = Math.max(t[i], start);
        const to = i + 1 < n ? Math.min(t[i + 1], end) : end;
        if (to <= from) continue; // never held inside the window
        if (v[i] === null) {
            flush();
            joined = false;
            continue;
        }
        const xa = xOf(from);
        const xb = xOf(to);
        const y = yOf(v[i]);
        const col = Math.floor(xa);
        if (acc && acc.col === col) {
            acc.min = Math.min(acc.min, y);
            acc.max = Math.max(acc.max, y);
            acc.last = y;
            acc.xLast = xa;
            acc.xEnd = xb;
            acc.count++;
        } else {
            flush();
            acc = { col, move: !joined, xStart: xa, xLast: xa, xEnd: xb, first: y, last: y, min: y, max: y, count: 1 };
        }
        joined = true;
        if (Math.floor(xb) > col) flush();
    }
    flush();
    if (!parts.length) return null;

    return {
        t,
        v,
        start,
        end,
        yOf,
        path: parts.join(""),
        zeroY: lo < 0 && hi > 0 ? yOf(0) : null,
    };
}

function round2(x) {
    return Math.round(x * 100) / 100;
}

/* The graph div's persistent elements; listeners are attached once per div */
function graphView(divGraph) {
    let view = inspectors.get(divGraph);
    if (view) return view;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${GRAPH_W} ${GRAPH_H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.style.cssText = "display: block; width: 100%; height: 100%; overflow: visible;";

    const zero = document.createElementNS(SVG_NS, "path");
    zero.setAttribute("fill", "none");
    zero.setAttribute("stroke-opacity", "0.25");
    zero.setAttribute("stroke-width", "1");
    zero.setAttribute("stroke-dasharray", "3 3");
    zero.setAttribute("vector-effect", "non-scaling-stroke");

    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke-width", "3");
    line.setAttribute("stroke-linejoin", "round");
    line.setAttribute("stroke-linecap", "round");
    svg.append(zero, line);

    const cross = document.createElement("div");
    cross.style.cssText = "position: absolute; top: 0; bottom: 0; width: 0; display: none; " +
        "border-left: 1px dashed; opacity: 0.7; pointer-events: none;";

    const dot = document.createElement("div");
    dot.style.cssText = "position: absolute; width: 7px; height: 7px; border-radius: 50%; display: none; " +
        "transform: translate(-50%, -50%); pointer-events: none;";

    const valueEl = document.createElement("div");
    valueEl.style.cssText = "font-weight: 600; font-variant-numeric: tabular-nums;";
    const rangeEl = document.createElement("div");
    rangeEl.style.cssText = "opacity: 0.75; font-variant-numeric: tabular-nums;";

    const tip = document.createElement("div");
    tip.style.cssText = "position: absolute; bottom: calc(100% + 4px); left: 0; display: none; " +
        "padding: 3px 7px; border-radius: 4px; border: 1px solid transparent; " +
        "font-family: inherit; font-size: 12px; line-height: 1.35; white-space: normal; " +
        "max-width: calc(100% - 8px); box-sizing: border-box; overflow-wrap: anywhere; " +
        "box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); pointer-events: none; cursor: text; " +
        "user-select: text; -webkit-user-select: text;";
    tip.append(valueEl, rangeEl);

    divGraph.replaceChildren(svg, cross, dot, tip);

    view = {
        divGraph, svg, zero, line, cross, dot, tip, valueEl, rangeEl,
        appendTo: null, entity: "", plot: null, color: "",
        active: null,          // { time: ms, pinned: boolean } or null
        lastPointerType: "",
    };
    inspectors.set(divGraph, view);
    if (!divGraph._vrmInspect) attachInspection(divGraph);
    return view;
}

/* Hover (mouse/pen) follows the pointer; a tap/click pins or unpins. */
function attachInspection(divGraph) {
    divGraph._vrmInspect = true;

    const contain = (ev) => ev.stopPropagation();
    for (const type of CONTAINED_EVENTS) {
        divGraph.addEventListener(type, contain, type.startsWith("touch") ? { passive: true } : false);
    }

    divGraph.addEventListener("pointerdown", (ev) => {
        const view = inspectors.get(divGraph);
        if (view) view.lastPointerType = ev.pointerType || "";
    });

    divGraph.addEventListener("pointermove", (ev) => {
        const view = inspectors.get(divGraph);
        if (!view?.plot || ev.pointerType === "touch" || view.active?.pinned) return;
        const time = eventTime(view, ev);
        if (time === null) return;
        view.active = { time, pinned: false };
        renderInspection(view);
    });

    divGraph.addEventListener("pointerleave", () => {
        const view = inspectors.get(divGraph);
        if (!view || view.active?.pinned) return;
        view.active = null;
        renderInspection(view);
    });

    divGraph.addEventListener("click", (ev) => {
        const view = inspectors.get(divGraph);
        if (!view?.plot) return;
        // clicks inside the pinned tooltip, or ending a text selection there,
        // leave the pin alone so its text can be selected and copied
        if (view.tip.contains(ev.target) || selectionInside(view.tip)) return;
        const time = eventTime(view, ev);
        if (view.active?.pinned) {
            const hovering = view.lastPointerType === "mouse" || view.lastPointerType === "pen";
            view.active = hovering && time !== null ? { time, pinned: false } : null;
        } else if (time !== null) {
            view.active = { time, pinned: true };
        }
        renderInspection(view);
    });
}

function selectionInside(el) {
    const root = el.getRootNode();
    // Chromium exposes the selection inside a shadow root only via the root
    const selection = (typeof root.getSelection === "function" ? root.getSelection() : null) || window.getSelection();
    return !!selection && !selection.isCollapsed &&
        (el.contains(selection.anchorNode) || el.contains(selection.focusNode));
}

/* Pointer x → time (ms) within the plotted window */
function eventTime(view, ev) {
    const rect = view.svg.getBoundingClientRect();
    if (!rect.width || !Number.isFinite(ev.clientX)) return null;
    const frac = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1);
    return view.plot.start + frac * (view.plot.end - view.plot.start);
}

function hideInspection(view) {
    view.cross.style.display = "none";
    view.dot.style.display = "none";
    view.tip.style.display = "none";
    view.tip.style.pointerEvents = "none";
    view.divGraph.style.zIndex = "";
}

function renderInspection(view) {
    const { plot, active } = view;
    if (!plot || !active) {
        hideInspection(view);
        return;
    }

    const info = describeAt(view, active.time);
    const frac = Math.min(Math.max((active.time - plot.start) / (plot.end - plot.start), 0), 1);
    const left = `${frac * 100}%`;

    view.cross.style.left = left;
    view.cross.style.display = "block";
    if (info.y === null) {
        view.dot.style.display = "none";
    } else {
        view.dot.style.left = left;
        view.dot.style.top = `${(info.y / GRAPH_H) * 100}%`;
        view.dot.style.display = "block";
    }

    // textContent is only touched when the text changes, so a selection in a
    // pinned tooltip survives refreshes that do not alter it
    setText(view.valueEl, info.value);
    setText(view.rangeEl, info.range);
    view.valueEl.style.fontStyle = info.measured ? "" : "italic";
    view.tip.style.borderColor = active.pinned ? view.color : "transparent";
    view.tip.style.pointerEvents = active.pinned ? "auto" : "none";
    view.tip.style.display = "block";
    view.divGraph.style.zIndex = INSPECT_Z_INDEX;

    // horizontally centred on the crosshair, clamped to the graph width
    const graphWidth = view.divGraph.clientWidth;
    const tipWidth = view.tip.offsetWidth;
    const x = frac * graphWidth;
    const tipLeft = tipWidth >= graphWidth
        ? (graphWidth - tipWidth) / 2
        : Math.min(Math.max(x - tipWidth / 2, 0), graphWidth - tipWidth);
    view.tip.style.left = `${tipLeft}px`;
    const graphBounds = view.divGraph.getBoundingClientRect();
    const boxBounds = view.divGraph.parentElement.getBoundingClientRect();
    const bottom = Math.min(graphBounds.height + 4, graphBounds.bottom - boxBounds.top - view.tip.offsetHeight - 4);
    view.tip.style.bottom = `${bottom}px`;
}

function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
}

/** The held measurement and its interval at a time. */
function describeAt(view, time) {
    const { plot } = view;
    const hass = view.appendTo ? getState(view.appendTo).hass : null;
    const fmt = timeLabeler(hass, plot.end);

    // last row with t <= time (equal timestamps: the later row is the one held)
    let lowIndex = 0;
    let highIndex = plot.t.length - 1;
    let index = -1;
    while (lowIndex <= highIndex) {
        const mid = (lowIndex + highIndex) >> 1;
        if (plot.t[mid] <= time) {
            index = mid;
            lowIndex = mid + 1;
        } else {
            highIndex = mid - 1;
        }
    }

    if (index < 0) {
        return { value: "no data", range: `before ${fmt(plot.t[0])}`, y: null, measured: false };
    }

    const from = plot.t[index];
    const to = index + 1 < plot.t.length ? plot.t[index + 1] : null;
    const fromLabel = from <= plot.start ? `≤ ${fmt(from)}` : fmt(from);
    const range = to === null ? `since ${fromLabel}` : `${fromLabel} – ${fmt(to)}`;
    const value = plot.v[index];
    if (value === null) {
        return { value: unavailableLabel(hass), range, y: null, measured: false };
    }
    return { value: formatHistoryValue(hass, view.entity, value), range, y: plot.yOf(value), measured: true };
}

function unavailableLabel(hass) {
    try {
        const text = hass?.localize?.("state.default.unavailable");
        if (typeof text === "string" && text) return text;
    } catch (e) {
        // English fallback below
    }
    return "unavailable";
}

/* Historical readings use entity display precision and the profile's number format. */
const NUMBER_LOCALE = { comma_decimal: "en-US", decimal_comma: "de", space_comma: "fr" };

function formatHistoryValue(hass, id, value) {
    const unit = hass?.states?.[id]?.attributes?.unit_of_measurement || "";
    const precision = hass?.entities?.[id]?.display_precision;
    const numberFormat = hass?.locale?.number_format;
    const locale = numberFormat === "system" ? undefined
        : NUMBER_LOCALE[numberFormat] || hass?.locale?.language || hass?.language || undefined;
    const options = Number.isInteger(precision) && precision >= 0 && precision <= 20
        ? { minimumFractionDigits: precision, maximumFractionDigits: precision }
        : { maximumFractionDigits: 2 };
    if (numberFormat === "none") options.useGrouping = false;

    let text;
    try {
        text = new Intl.NumberFormat(locale, options).format(value);
    } catch (e) {
        text = String(value);
    }
    return unit ? `${text} ${unit}` : text;
}

/* Formatters per locale/time zone/clock setting, created once */
const timeFormatterCache = new Map();

function timeFormatters(hass) {
    const language = hass?.locale?.language || hass?.language || undefined;
    // Home Assistant profile: show times in the server's or the browser's zone
    const timeZone = hass?.locale?.time_zone === "server" ? hass?.config?.time_zone || undefined : undefined;
    const clock = hass?.locale?.time_format;
    const hour12 = clock === "12" ? true : clock === "24" ? false : undefined;
    const key = `${language}|${timeZone}|${hour12}`;
    let formatters = timeFormatterCache.get(key);
    if (formatters) return formatters;

    const make = (lang, zone) => ({
        time: new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12, timeZone: zone }),
        weekday: new Intl.DateTimeFormat(lang, { weekday: "short", timeZone: zone }),
        day: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }),
    });
    try {
        formatters = make(language, timeZone);
    } catch (e) {
        // unknown language tag or time zone: browser defaults
        formatters = make(undefined, undefined);
    }
    timeFormatterCache.set(key, formatters);
    return formatters;
}

/* Time of day; prefixed with the weekday when not on the window's last day */
function timeLabeler(hass, reference) {
    const { time, weekday, day } = timeFormatters(hass);
    const referenceDay = day.format(reference);
    return (ms) => day.format(ms) === referenceDay
        ? time.format(ms)
        : `${weekday.format(ms)} ${time.format(ms)}`;
}

/******************************************************/
/* Connection lines                                   */
/* Redrawn when the width changes or a redraw was     */
/* requested (structure, theme, reconnect).           */
/******************************************************/
export function checkReSize(config, isDarkTheme, appendTo) {

    const state = getState(appendTo);
    const dashboard = appendTo.querySelector("#dashboard");
    if (!dashboard) return;

    // not rendered (hidden tab, conditional card): the ResizeObserver fires again once visible
    const rect = dashboard.getBoundingClientRect();
    if (rect.width === 0) return;

    // rounded width: sub-pixel jitter after DOM updates must not trigger redraws
    const roundedWidth = Math.round(rect.width);
    if (state.dashboardOldWidth === roundedWidth && !state.mustRedrawLine) return;

    state.mustRedrawLine = false;
    state.dashboardOldWidth = roundedWidth;

    if (state.lineRafId !== null) cancelAnimationFrame(state.lineRafId);

    // measure anchors after layout of the freshly written box contents
    state.lineRafId = requestAnimationFrame(() => {
        state.lineRafId = null;
        cancelLines(state);
        appendTo.querySelector("#dashboard > #svg_container > #circ_container")?.replaceChildren();
        appendTo.querySelector("#dashboard > #svg_container > #path_container")?.replaceChildren();
        const bounds = dashboard.getBoundingClientRect();
        appendTo.querySelector("#svg_container").setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
        addLine(config, isDarkTheme, appendTo);
        checkForReverse(config, state.hass, appendTo);
    });
}

export function razDashboardOldWidth(appendTo) {
    if (appendTo) getState(appendTo).mustRedrawLine = true;
}

function cancelLines(state) {
    state.pathControls.forEach((ctrl) => ctrl.cancel());
    state.pathControls.clear();
}

function addLine(config, isDarkTheme, appendTo) {
    for (const boxId of visibleBoxIds(config)) {
        for (const [linkId, link] of validLinks(config.devices[boxId])) {
            const direction = isTrue(link.inv) ? -1 : 1;
            creatLine(`${boxId}#${linkId}`, `${boxId}_${link.start}`, link.end, direction, isDarkTheme, appendTo, config);
        }
    }
}

/*********************************************************/
/* One line between two anchors plus its animated ball.  */
/* direction_init: +1 = start → end, -1 = end → start    */
/*********************************************************/
function creatLine(key, anchorId1, anchorId2, direction_init, isDarkTheme, appendTo, config) {

    const circContainer = appendTo.querySelector("#dashboard > #svg_container > #circ_container");
    const pathContainer = appendTo.querySelector("#dashboard > #svg_container > #path_container");
    if (!circContainer || !pathContainer) return;

    let coords1 = getAnchorCoordinates(anchorId1, appendTo);
    let coords2 = getAnchorCoordinates(anchorId2, appendTo);
    // missing anchor (removed in the editor, box hidden): no line
    if (!coords1 || !coords2) return;

    let pathData = "";

    if (coords1.x === coords2.x || coords1.y === coords2.y) {
        pathData = `M ${coords1.x} ${coords1.y} L ${coords2.x} ${coords2.y}`;
    } else {

        const anchor1isH = /_[LR]-/.test(anchorId1);
        const anchor2isH = /_[LR]-/.test(anchorId2);

        if (anchor1isH && anchor2isH) {
            // horizontal → vertical → horizontal
            const midX = (coords1.x + coords2.x) / 2;
            pathData = `
                M ${coords1.x} ${coords1.y}
                C ${midX} ${coords1.y}, ${midX} ${coords1.y}, ${midX} ${(coords1.y + coords2.y) / 2}
                C ${midX} ${coords2.y}, ${midX} ${coords2.y}, ${coords2.x} ${coords2.y}
            `;
        } else if (!anchor1isH && !anchor2isH) {
            // vertical → horizontal → vertical
            const midY = (coords1.y + coords2.y) / 2;
            pathData = `
                M ${coords1.x} ${coords1.y}
                C ${coords1.x} ${midY}, ${coords1.x} ${midY}, ${(coords1.x + coords2.x) / 2} ${midY}
                C ${coords2.x} ${midY}, ${coords2.x} ${midY}, ${coords2.x} ${coords2.y}
            `;
        } else {
            // a single bend; the path always starts at the vertical anchor,
            // so the travel direction is flipped when the anchors are swapped
            if (anchor1isH) {
                [coords1, coords2] = [coords2, coords1];
                direction_init = -direction_init;
            }
            pathData = `
                M ${coords1.x} ${coords1.y}
                C ${coords1.x} ${coords2.y}, ${coords1.x} ${coords2.y}, ${coords2.x} ${coords2.y}
            `;
        }
    }

    if (pathData.includes("NaN")) return;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "none");
    const scale = appendTo.querySelector("#dashboard").getBoundingClientRect().width / 1000;
    path.setAttribute("stroke-width", String(Math.max(1, 2 * scale)));

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "ball");
    circle.setAttribute("cx", coords1.x);
    circle.setAttribute("cy", coords1.y);
    circle.setAttribute("r", String(ballSize(config.param) * scale));
    circle.setAttribute("fill", isDarkTheme ? "url(#gradientDark)" : "url(#gradientLight)");
    circle.style.visibility = "hidden";

    pathContainer.appendChild(path);
    circContainer.appendChild(circle);

    getState(appendTo).pathControls.set(key, animateBallAlongPath(path, circle, direction_init, appendTo));
}

function getAnchorCoordinates(anchorId, appendTo) {

    const match = ANCHOR_ID.exec(anchorId);
    if (!match) return null;
    const boxId = match[1];

    const anchor = appendTo.querySelector(`#dashboard > #column-${boxId[0]} > #box_${boxId} > #anchor_${anchorId}`);
    const container = appendTo.querySelector("#dashboard");
    if (!anchor || !container) return null;

    const anchorRect = anchor.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height) return null;

    // The SVG and its anchors share the card's CSS-pixel coordinate space.
    const relativeX = anchorRect.left - containerRect.left + anchorRect.width / 2;
    const relativeY = anchorRect.top - containerRect.top + anchorRect.height / 2;

    return { x: parseFloat(relativeX.toFixed(2)), y: parseFloat(relativeY.toFixed(2)) };
}

/******************************************************************/
/* Ball animation. The ball stays hidden until checkForReverse    */
/* supplies a signal; reverse(cmd) with cmd ∈ {-1, 0, 1}.         */
/******************************************************************/
function animateBallAlongPath(path, circle, directionInit, appendTo) {

    let direction = 0;

    const pathLength = path.getTotalLength();
    const speed = appendTo.querySelector("#dashboard").offsetWidth / 10; // upstream speed
    const duration = speed > 0 ? pathLength / speed * 1000 : 0;
    let startTime;
    let rafId = null;

    function moveBall(time) {
        rafId = null;
        if (direction === 0 || duration <= 0) {
            circle.style.visibility = "hidden";
            return;
        }
        if (!startTime) startTime = time;

        let progress = ((time - startTime) % duration) / duration;
        if (direction === -1) progress = 1 - progress;

        const point = path.getPointAtLength(progress * pathLength);
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        circle.style.visibility = "visible";
        rafId = requestAnimationFrame(moveBall);
    }

    return {
        reverse(cmd) {
            const next = directionInit * cmd;
            if (next === direction) return;
            direction = next;
            if (direction === 0) {
                if (rafId !== null) cancelAnimationFrame(rafId);
                rafId = null;
                circle.style.visibility = "hidden";
            } else if (rafId === null) {
                rafId = requestAnimationFrame(moveBall);
            }
        },
        cancel() {
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = null;
        },
    };
}

/******************************************************/
/* Flow direction from each link's signal entity      */
/******************************************************/
export function checkForReverse(config, hass, appendTo) {

    const { pathControls } = getState(appendTo);
    if (!hass) return;

    for (const boxId of visibleBoxIds(config)) {
        for (const [linkId, link] of validLinks(config.devices[boxId])) {
            const control = pathControls.get(`${boxId}#${linkId}`);
            if (!control) continue;
            const signal = entityId(link.entity);
            const value = signal ? numericState(hass.states?.[signal]) : null;
            control.reverse(value === null || Math.abs(value) <= FLOW_DEADBAND ? 0 : Math.sign(value));
        }
    }
}

/* Stop every animation frame of this card and forget drawn lines/graphs */
export function stopAnimations(appendTo) {
    const state = getState(appendTo);
    if (state.lineRafId !== null) {
        cancelAnimationFrame(state.lineRafId);
        state.lineRafId = null;
    }
    cancelLines(state);
    state.graphDrawn.clear();
    state.mustRedrawLine = true;
}

/******************************************************/
/* History                                            */
/******************************************************/

/* Main entities of visible boxes with a sparkline, sorted and unique */
export function graphEntities(config) {
    const ids = new Set();
    for (const boxId of visibleBoxIds(config)) {
        const device = config.devices[boxId];
        const id = entityId(device.entity);
        if (isTrue(device.graph) && id) ids.add(id);
    }
    return Array.from(ids).sort();
}

/**
 * One recorder history request for all entities. Resolves to a Map of
 * entity id → the complete chronological series of Recorder state changes
 * (`{ time, value }`, value null while unknown/unavailable/non-numeric) for
 * entities with at least one numeric value; throws when the request fails.
 * The caller owns scheduling and discards stale results.
 */
export async function fetchHistory(hass, entityIds, periodInHours = HISTORY_HOURS) {
    const startTime = new Date(Date.now() - periodInHours * 60 * 60 * 1000);
    const url = `history/period/${startTime.toISOString()}` +
        `?filter_entity_id=${entityIds.map(encodeURIComponent).join(",")}` +
        "&minimal_response=true&no_attributes=true&significant_changes_only=true";

    const response = await hass.callApi("GET", url);
    const fetchedAt = Date.now();
    const series = new Map();
    if (!Array.isArray(response)) return series;

    for (const rows of response) {
        // with minimal_response only the first row of each entity carries entity_id
        if (!Array.isArray(rows) || !rows.length) continue;
        const id = rows[0]?.entity_id;
        if (!entityIds.includes(id)) continue;
        const points = historyPoints(rows);
        if (!points.some((p) => p.value !== null)) continue;
        // The window the series covers, for time-proportional drawing. The end
        // is never before the last row (browser and server clocks may differ).
        historyWindows.set(points, {
            start: startTime.getTime(),
            end: Math.max(fetchedAt, points[points.length - 1].time.getTime()),
        });
        series.set(id, points);
    }
    return series;
}

/**
 * Recorder rows → chronological held values with their actual timestamps.
 * Nothing is resampled or averaged. Rows repeating the previous value add no
 * information to a step function and are dropped, so each point's time is
 * when its value began. Home Assistant reports the state already in effect at
 * the window start with the requested start time as its timestamp.
 */
function historyPoints(rows) {
    const points = [];
    for (const item of rows) {
        // REST rows: last_changed (ISO); websocket-style rows: lc/lu (epoch seconds)
        const epoch = item.lc ?? item.lu;
        const time = new Date(item.last_changed ?? item.last_updated ?? (typeof epoch === "number" ? epoch * 1000 : NaN));
        if (isNaN(time.getTime())) continue;
        points.push({ time, value: numericState({ state: item.state ?? item.s }) });
    }
    points.sort((a, b) => a.time - b.time);
    return points.filter((point, i) => i === 0 || point.value !== points[i - 1].value);
}
