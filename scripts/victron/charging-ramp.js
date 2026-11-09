const fullCurrent = Number(env.get("FULL_CHARGE_CURRENT_A"));
const duration = Number(env.get("RAMP_DURATION_SECONDS"));
const stepSeconds = 10;
const normalLimit = -1;
const state = context.get("state") || {
  source: null,
  observedLimit: null,
  requestedLimit: null,
  ready: false,
  override: false,
  elapsed: 0,
  mode: "waiting",
};

function save() {
  context.set("state", state);
  const text = state.mode === "ramping"
    ? `${state.requestedLimit}/${fullCurrent} A; ${Math.ceil((duration - state.elapsed) / 60)} min remaining`
    : state.mode;
  node.status({ fill: state.mode === "waiting" ? "yellow" : "green", shape: "dot", text });
}

function stopTimer() {
  const timer = context.get("timer");
  if (timer) clearInterval(timer);
  context.set("timer", null);
}

function setLimit(value) {
  state.requestedLimit = value;
  node.send({ payload: value });
  save();
}

function fullCharging() {
  stopTimer();
  state.override = true;
  state.mode = "override: full charging until next outage";
  setLimit(normalLimit);
}

function applySource() {
  stopTimer();
  state.elapsed = 0;
  if (state.override) {
    fullCharging();
  } else if (state.source === 1) {
    state.mode = "ramping";
    setLimit(0);
    const timer = setInterval(() => {
      if (state.mode !== "ramping" || state.source !== 1) return;
      // Timer steps preserve the ramp rate across wall-clock corrections.
      state.elapsed = Math.min(duration, state.elapsed + stepSeconds);
      if (state.elapsed === duration) {
        stopTimer();
        state.mode = "normal charging";
        setLimit(normalLimit);
      } else {
        setLimit(Math.round(fullCurrent * state.elapsed / duration));
      }
    }, stepSeconds * 1000);
    context.set("timer", timer);
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

if (msg.topic === "full") {
  fullCharging();
} else if (msg.topic === "grid") {
  const source = msg.payload;
  if (![0, 1, 2, 3, 240].includes(source)) {
    stopTimer();
    state.source = null;
    state.ready = false;
    state.mode = "waiting for grid source";
    setLimit(state.override ? normalLimit : 0);
    node.error("AC input source is unavailable.", msg);
    return null;
  }
  const previous = state.source;
  state.source = source;
  if (state.ready && previous !== source) {
    if (previous === 1 && source !== 1) state.override = false;
    applySource();
  }
} else if (msg.topic === "limit") {
  if (typeof msg.payload !== "number" || !Number.isFinite(msg.payload) || msg.payload < normalLimit) {
    stopTimer();
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
save();
return null;
