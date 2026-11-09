import { fetchHistory, getHistoryWindow } from "./lib-venus.js";

const HOURS = 24;
const REFRESH_MS = 5 * 60 * 1000;


/** An inline history strip with a selected-point reading beneath it. */
export function historyMarkup(name, color, top, width = 340) {
  return `<g data-history="${name}" data-top="${top}" data-width="${width}"
      role="button" tabindex="0" aria-label="${name} history; Enter to pin, Escape to dismiss">
    <rect x="1" y="${top}" width="${width - 2}" height="110" fill="transparent"/>
    <path data-area fill="${color}" fill-opacity="0.25" pointer-events="none"/>
    <path data-line fill="none" stroke="${color}" stroke-width="2.5" pointer-events="none"/>
    <text data-status x="${width / 2}" y="${top + 40}" text-anchor="middle" font-size="22">Loading history…</text>
    <g data-inspector visibility="hidden">
      <circle data-halo r="16" fill="${color}" fill-opacity="0.3" pointer-events="none"/>
      <circle data-point r="8" fill="${color}" stroke="#fff" stroke-width="2" pointer-events="none"/>
      <text data-date data-inspection-text x="22" y="${top + 97}" font-size="23" style="user-select:text"/>
      <text data-value data-inspection-text x="${width - 22}" y="${top + 97}" font-size="23" text-anchor="end" style="user-select:text"/>
    </g>
    <line x1="1" x2="${width - 1}" y1="${top + 110}" y2="${top + 110}" stroke="#4e4e4e" stroke-width="2"/>
  </g>`;
}

/** Recorder history and read-only inspection for the overview's inline strips. */
export function mountOverviewHistory(svg, bindings) {
  const events = new AbortController();
  let hass;
  let closed = false;
  let loading = false;
  let timer;
  let frame;
  const plots = bindings.map((binding) => {
    const group = svg.querySelector(`[data-history="${binding.name}"]`);
    return {
      ...binding, group, top: Number(group.dataset.top), width: Number(group.dataset.width),
      rows: [], start: 0, end: 0, active: null, state: null, ready: false,
      area: group.querySelector("[data-area]"), line: group.querySelector("[data-line]"),
      status: group.querySelector("[data-status]"), inspector: group.querySelector("[data-inspector]"),
      date: group.querySelector("[data-date]"), value: group.querySelector("[data-value]"),
      halo: group.querySelector("[data-halo]"), point: group.querySelector("[data-point]"),
    };
  });

  const setText = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };
  const position = (plot, time) => 1 + ((time - plot.start) / (plot.end - plot.start)) * (plot.width - 2);
  const rowAt = (plot, time) => {
    let low = 0;
    let high = plot.rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (plot.rows[mid].time <= time) low = mid + 1;
      else high = mid;
    }
    return low - 1;
  };
  const updateInspection = (plot) => {
    if (!plot.active || !plot.start || plot.active.time < plot.start) {
      plot.active = null;
      plot.inspector.setAttribute("visibility", "hidden");
      plot.group.setAttribute("aria-pressed", "false");
      return;
    }
    const { time, pinned } = plot.active;
    const index = rowAt(plot, time);
    const value = index < 0 ? null : plot.rows[index].value;
    const language = hass?.locale?.language || hass?.language;
    const timeZone = hass?.locale?.time_zone === "server" ? hass?.config?.time_zone : undefined;
    const clock = hass?.locale?.time_format;
    const hour12 = clock === "12" ? true : clock === "24" ? false : undefined;
    let date;
    try {
      date = new Intl.DateTimeFormat(language, {
        month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12, timeZone,
      }).format(time);
    } catch {
      date = new Date(time).toLocaleString();
    }
    setText(plot.date, date);
    setText(plot.value, value === null ? "Unavailable" : plot.format(value));
    plot.inspector.setAttribute("visibility", "visible");
    plot.group.setAttribute("aria-pressed", String(pinned));
    for (const point of [plot.halo, plot.point]) {
      point.setAttribute("visibility", value === null || !plot.y ? "hidden" : "visible");
      if (value !== null && plot.y) {
        point.setAttribute("cx", String(position(plot, time)));
        point.setAttribute("cy", String(plot.y(value)));
      }
    }
  };

  const draw = (plot) => {
    const numeric = plot.rows.filter((row) => row.value !== null);
    if (!numeric.length || plot.end <= plot.start) {
      plot.area.removeAttribute("d");
      plot.line.removeAttribute("d");
      plot.y = null;
      setText(plot.status, plot.ready ? "History unavailable" : "Loading history…");
      updateInspection(plot);
      return;
    }
    setText(plot.status, "");
    let min = 0;
    let max = plot.percent ? 100 : 1;
    if (!plot.percent) {
      for (const { value } of numeric) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    plot.y = (value) => plot.top + 3 + ((max - Math.min(max, Math.max(min, value))) / (max - min)) * 58;
    const zero = plot.y(0);
    const line = [];
    const area = [];
    let run = [];
    const flushRun = () => {
      if (!run.length) return;
      line.push(`M${run.join("L")}`);
      const firstX = run[0].split(",")[0];
      const lastX = run.at(-1).split(",")[0];
      area.push(`M${firstX},${zero}L${run.join("L")}L${lastX},${zero}Z`);
      run = [];
    };
    // Per-column extrema bound drawing cost while inspection retains every change.
    let bucket;
    const flushBucket = () => {
      if (!bucket) return;
      run.push(`${bucket.x},${bucket.first}`);
      if (bucket.count > 1) run.push(`${bucket.lastX},${bucket.first}`, `${bucket.lastX},${bucket.min}`, `${bucket.lastX},${bucket.max}`, `${bucket.lastX},${bucket.last}`);
      run.push(`${bucket.endX},${bucket.last}`);
      bucket = null;
    };
    for (let i = 0; i < plot.rows.length; i++) {
      const row = plot.rows[i];
      const from = Math.max(row.time, plot.start);
      const to = Math.min(plot.rows[i + 1]?.time ?? plot.end, plot.end);
      if (to <= from) continue;
      if (row.value === null) {
        flushBucket();
        flushRun();
        continue;
      }
      const x = position(plot, from);
      const endX = position(plot, to);
      const y = plot.y(row.value);
      const column = Math.floor(x);
      if (bucket?.column === column) {
        bucket.lastX = x;
        bucket.endX = endX;
        bucket.min = Math.min(bucket.min, y);
        bucket.max = Math.max(bucket.max, y);
        bucket.last = y;
        bucket.count++;
      } else {
        flushBucket();
        bucket = { column, x, endX, lastX: x, first: y, last: y, min: y, max: y, count: 1 };
      }
      if (Math.floor(endX) > column) flushBucket();
    }
    flushBucket();
    flushRun();
    plot.line.setAttribute("d", line.join(""));
    plot.area.setAttribute("d", area.join(""));
    updateInspection(plot);
  };

  const scheduleDraw = () => {
    if (frame !== undefined || closed) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!closed) for (const plot of plots) draw(plot);
    });
  };
  const appendLive = (plot) => {
    const state = hass?.states?.[plot.entity];
    if (!state || state === plot.state) return;
    plot.state = state;
    if (!plot.ready) return;
    const time = Date.parse(state.last_changed);
    const value = plot.read(state);
    if (!Number.isFinite(time)) return;
    if (time > (plot.rows.at(-1)?.time ?? -Infinity)) plot.rows.push({ time, value });
    plot.end = Math.max(Date.now(), time);
    plot.start = plot.end - HOURS * 60 * 60 * 1000;
    const first = Math.max(0, rowAt(plot, plot.start));
    if (first) plot.rows.splice(0, first);
  };

  const refresh = async () => {
    if (closed || loading || !hass) return;
    loading = true;
    try {
      const history = await fetchHistory(hass, [...new Set(plots.map((plot) => plot.entity))], HOURS);
      if (closed) return;
      const now = Date.now();
      for (const plot of plots) {
        const rows = history.get(plot.entity) || [];
        const window = getHistoryWindow(rows);
        const attributes = hass.states[plot.entity]?.attributes;
        plot.rows = rows.map((row) => ({
          time: row.time.getTime(),
          value: row.value === null ? null : plot.read({ state: String(row.value), attributes }),
        }));
        plot.start = window?.start ?? now - HOURS * 60 * 60 * 1000;
        plot.end = window?.end ?? now;
        plot.ready = true;
        plot.state = null;
        appendLive(plot);
      }
      scheduleDraw();
    } catch {
      if (!closed) for (const plot of plots) {
        if (!plot.ready) {
          plot.ready = true;
          draw(plot);
        }
      }
    } finally {
      loading = false;
    }
  };

  for (const plot of plots) {
    const timeAt = (event) => {
      const matrix = plot.group.getScreenCTM();
      if (!matrix || !plot.start) return null;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const ratio = Math.min(1, Math.max(0, (point.x - 1) / (plot.width - 2)));
      return plot.start + ratio * (plot.end - plot.start);
    };
    for (const type of ["pointerdown", "pointerup", "pointermove", "touchstart", "touchend", "click", "action", "keydown"]) {
      plot.group.addEventListener(type, (event) => event.stopPropagation(), { signal: events.signal, passive: type.startsWith("touch") });
    }
    plot.group.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch" || plot.active?.pinned || event.target.closest("[data-inspection-text]")) return;
      const time = timeAt(event);
      if (time !== null) plot.active = { time, pinned: false };
      updateInspection(plot);
    }, { signal: events.signal });
    plot.group.addEventListener("pointerleave", () => {
      if (!plot.active?.pinned) plot.active = null;
      updateInspection(plot);
    }, { signal: events.signal });
    plot.group.addEventListener("click", (event) => {
      if (event.target.closest("[data-inspection-text]")) return;
      const time = timeAt(event);
      plot.active = plot.active?.pinned ? null : time === null ? null : { time, pinned: true };
      updateInspection(plot);
    }, { signal: events.signal });
    plot.group.addEventListener("keydown", (event) => {
      if (event.key === "Escape") plot.active = null;
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        plot.active = plot.active?.pinned ? null : { time: plot.active?.time ?? plot.end, pinned: true };
      } else return;
      updateInspection(plot);
    }, { signal: events.signal });
  }

  return {
    update(nextHass) {
      hass = nextHass;
      if (!timer && !closed && hass && svg.isConnected) {
        timer = setInterval(refresh, REFRESH_MS);
        void refresh();
      }
      let changed = false;
      for (const plot of plots) {
        if (hass?.states?.[plot.entity] !== plot.state) {
          appendLive(plot);
          changed = true;
        }
      }
      if (changed) scheduleDraw();
    },
    close() {
      closed = true;
      clearInterval(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      events.abort();
    },
  };
}
