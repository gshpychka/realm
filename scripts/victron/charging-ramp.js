const fullCurrent = Number(env.get("FULL_CHARGE_CURRENT_A"));
const duration = Number(env.get("RAMP_DURATION_SECONDS"));
const stepSeconds = 10;
const normalLimit = -1;
// Default node-local context is cleared when its node closes.
const state = flow.get("state") || {
  source: null,
  lastSource: null,
  observedLimit: null,
  requestedLimit: null,
  ready: false,
  override: false,
  soc: null,
  windowOpen: false,
  elapsed: 0,
  mode: "waiting",
};

function save() {
  flow.set("state", state);
  const windowActive = state.windowOpen;
  const text = state.mode === "ramping"
    ? `${state.requestedLimit}/${fullCurrent} A; ${Math.ceil((duration - state.elapsed) / 60)} min remaining`
    : state.mode;
  node.status({ fill: state.mode === "waiting" ? "yellow" : "green", shape: "dot", text });
  const labels = {
    "ramping": "Ramping",
    "normal charging": "Normal charging",
    "outage: ramp armed": "Waiting for grid",
    "override: full charging": "Full charging override",
    "generator or shore charging": "Generator / shore charging",
  };
  node.send([null, { payload: {
    state: labels[state.mode] || "Waiting for data",
    phase: state.mode,
    elapsed_seconds: windowActive ? state.elapsed : 0,
    remaining_seconds: windowActive ? Math.max(0, duration - state.elapsed) : 0,
    duration_seconds: duration,
    target_current_a: fullCurrent,
    charging_limit_a: state.observedLimit,
    override: state.override,
    window_open: state.windowOpen,
    grid_source: state.source,
    battery_soc: state.soc,
    ready: state.ready,
  } }]);
}

function stopTimer() {
  const timer = context.get("timer");
  if (timer) clearInterval(timer);
  context.set("timer", null);
}

function setLimit(value) {
  state.requestedLimit = value;
  node.send([{ payload: value }, null]);
  save();
}

function fullCharging() {
  if (!state.windowOpen || state.source !== 1 || state.soc === 100 || state.elapsed >= duration) {
    finishWindow();
    return;
  }
  state.override = true;
  state.mode = "override: full charging";
  setLimit(normalLimit);
}

function finishWindow() {
  stopTimer();
  state.override = false;
  state.windowOpen = false;
  state.mode = "normal charging";
  setLimit(normalLimit);
}

function throttleCharging() {
  if (!state.ready || state.source !== 1) {
    node.warn("Grid charging inputs are unavailable.");
    return;
  }
  if (!state.windowOpen) {
    state.windowOpen = true;
    state.elapsed = 0;
  }
  state.override = false;
  state.mode = "ramping";
  setLimit(Math.round(fullCurrent * state.elapsed / duration));
  startTimer();
}

function startTimer() {
  if (context.get("timer")) return;
  const timer = setInterval(() => {
    if (!state.windowOpen) return;
    // Timer steps preserve the ramp rate across wall-clock corrections.
    state.elapsed = Math.min(duration, state.elapsed + stepSeconds);
    if (state.elapsed === duration) {
      finishWindow();
    } else if (state.override || !state.ready || state.source !== 1) {
      save();
    } else {
      setLimit(Math.round(fullCurrent * state.elapsed / duration));
    }
  }, stepSeconds * 1000);
  context.set("timer", timer);
}

function applySource() {
  if (!state.windowOpen) stopTimer();
  if (state.override) {
    fullCharging();
  } else if (state.source === 1 && state.windowOpen) {
    state.mode = "ramping";
    setLimit(Math.round(fullCurrent * state.elapsed / duration));
    startTimer();
  } else if (state.source === 1) {
    finishWindow();
  } else if (state.source === 2 || state.source === 3) {
    state.mode = "generator or shore charging";
    setLimit(normalLimit);
  } else {
    state.mode = "outage: ramp armed";
    setLimit(0);
  }
}

if (!Number.isFinite(fullCurrent) || fullCurrent <= 0 || !Number.isFinite(duration) || duration < stepSeconds) {
  node.error("Charging ramp requires a positive inverter current limit and a duration of at least ten seconds.", msg);
  return null;
}

if (msg.topic === "soc") {
  state.soc = typeof msg.payload === "number" && Number.isFinite(msg.payload) &&
    msg.payload >= 0 && msg.payload <= 100 ? msg.payload : null;
} else if (msg.topic === "full") {
  fullCharging();
} else if (msg.topic === "throttle") {
  throttleCharging();
} else if (msg.topic === "grid") {
  const source = msg.payload;
  if (![0, 1, 2, 3, 240].includes(source)) {
    state.source = null;
    state.ready = false;
    state.mode = "waiting for grid source";
    setLimit(state.override ? normalLimit : 0);
    node.error("AC input source is unavailable.", msg);
    return null;
  }
  const previous = state.lastSource;
  state.lastSource = source;
  state.source = source;
  if (source !== 1) {
    stopTimer();
    state.windowOpen = false;
    state.override = false;
    state.elapsed = 0;
  } else if (previous !== 1) {
    state.windowOpen = true;
    state.elapsed = 0;
  }
  if (state.ready && previous !== source) {
    applySource();
  }
} else if (msg.topic === "limit") {
  if (typeof msg.payload !== "number" || !Number.isFinite(msg.payload) || msg.payload < normalLimit) {
    state.observedLimit = null;
    state.ready = false;
    state.mode = "waiting for DVCC limit";
    save();
    node.error("DVCC charging-current limit is unavailable.", msg);
    return null;
  }
  state.observedLimit = msg.payload;
  if (state.ready && msg.payload === normalLimit &&
      (state.mode === "ramping" || state.mode === "outage: ramp armed")) {
    fullCharging();
  } else if (state.override && msg.payload !== normalLimit) {
    // An in-flight ramp write can arrive after the manual override.
    setLimit(normalLimit);
  }
}

if (!state.ready && state.source !== null && state.observedLimit !== null) {
  state.ready = true;
  applySource();
}
if (state.override && state.soc === 100) finishWindow();
if (state.windowOpen) startTimer();
save();
return null;
