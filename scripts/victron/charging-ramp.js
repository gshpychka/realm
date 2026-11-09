const stepSeconds = Number(env.get("RAMP_STEP_SECONDS"));
const normalLimit = Number(env.get("NORMAL_INPUT_CURRENT_A"));
const nominalVoltage = Number(env.get("NOMINAL_INPUT_VOLTAGE_V"));
const state = flow.get("gridRamp") || {
  available: null, lastAvailable: null, voltage: nominalVoltage,
  observedLimit: null, observedIgnore: null, requestedLimit: null, sentLimit: null,
  requestedIgnore: null, requestedPower: null, ready: false, dischargeAllowed: null,
  configuration: null, activeSettings: null, override: false, soc: null,
  windowOpen: false, elapsed: 0, mode: "waiting",
};
const numeric = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const flag = value => value === 1 || value === true ? true : value === 0 || value === false ? false : null;
const settings = () => state.activeSettings || state.configuration?.values;
const duration = () => (settings()?.duration_minutes || 0) * 60;
function save() {
  flow.set("gridRamp", state);
  const active = settings(), configured = state.configuration?.values;
  const labels = { ramping: "Ramping", "normal input": "Normal input", "override: normal input": "Input override", "outage: ramp armed": "No grid power" };
  node.status({ fill: state.ready ? "green" : "yellow", shape: "dot", text: state.mode });
  node.send([null, null, { payload: {
    state: labels[state.mode] || "Waiting for data", phase: state.mode,
    elapsed_seconds: state.windowOpen ? state.elapsed : 0,
    remaining_seconds: state.windowOpen ? Math.max(0, duration() - state.elapsed) : 0,
    duration_seconds: active ? duration() : null,
    start_current_a: active?.start_current_a ?? null, target_current_a: active?.target_current_a ?? null,
    target_power_w: active ? active.target_current_a * state.voltage : null,
    requested_power_w: state.requestedPower, input_limit_a: state.observedLimit,
    input_limit_w: state.observedIgnore === true ? 0 : state.observedIgnore === false && state.observedLimit !== null ? state.observedLimit * state.voltage : null,
    input_ignored: state.observedIgnore, input_voltage_v: state.voltage,
    configured_duration_minutes: configured?.duration_minutes ?? null,
    configured_start_current_a: configured?.start_current_a ?? null,
    configured_target_current_a: configured?.target_current_a ?? null,
    defaults: state.configuration?.defaults ?? null, override: state.override,
    window_open: state.windowOpen, grid_available: state.available, battery_soc: state.soc, ready: state.ready,
  } }]);
}
function ignore(value) {
  state.requestedIgnore = value;
  if (state.observedIgnore !== value) node.send([null, { payload: value ? 1 : 0 }, null]);
}
function writeLimit() {
  // A successful native current write precedes reconnection.
  if (state.requestedLimit === null || numeric(context.get("limitWrite")) !== null) return;
  if (state.sentLimit !== state.requestedLimit) {
    context.set("limitWrite", state.requestedLimit);
    node.send([{ payload: state.requestedLimit }, null, null]);
  } else if (state.requestedIgnore === false) ignore(false);
}
function normalInput() {
  state.requestedPower = null;
  if (state.requestedLimit !== normalLimit && state.observedLimit !== normalLimit) state.sentLimit = null;
  state.requestedIgnore = false;
  state.requestedLimit = normalLimit;
  writeLimit();
}
function stopTimer() {
  const timer = context.get("timer");
  if (timer) clearInterval(timer);
  context.set("timer", null);
}
function finishWindow() {
  stopTimer();
  state.windowOpen = false;
  state.override = false;
  state.activeSettings = null;
  state.mode = "normal input";
  normalInput();
}
function beginWindow() {
  state.windowOpen = true;
  state.elapsed = 0;
  state.override = false;
  state.activeSettings = state.configuration ? { ...state.configuration.values } : null;
}
function releaseInput() {
  if (!state.windowOpen || state.available !== true || state.elapsed >= duration()) return finishWindow();
  state.override = true;
  state.mode = "override: normal input";
  normalInput();
}
function applyRamp() {
  if (!state.ready || state.available !== true || !state.windowOpen || state.override || !state.activeSettings) return;
  state.mode = "ramping";
  const active = state.activeSettings;
  const amps = active.start_current_a + (active.target_current_a - active.start_current_a) * state.elapsed / duration();
  state.requestedPower = amps * state.voltage;
  if (amps === 0) {
    state.requestedLimit = null;
    ignore(true);
  } else {
    state.requestedIgnore = false;
    state.requestedLimit = Math.min(normalLimit, amps);
    if (state.requestedLimit === normalLimit && state.observedLimit !== normalLimit) state.sentLimit = null;
    writeLimit();
  }
}
function startTimer() {
  if (context.get("timer") || !state.windowOpen || !state.activeSettings) return;
  context.set("timer", setInterval(() => {
    state.elapsed = Math.min(duration(), state.elapsed + stepSeconds);
    if (state.elapsed >= duration()) finishWindow();
    else applyRamp();
    save();
  }, stepSeconds * 1000));
}
function applyAvailability() {
  if (state.available === false) {
    state.mode = "outage: ramp armed";
    state.requestedPower = 0;
    state.requestedLimit = null;
    ignore(true);
  } else if (state.override) releaseInput();
  else if (state.windowOpen) applyRamp();
  else { state.mode = "normal input"; normalInput(); }
}
const wasReady = state.ready;
let availabilityChanged = false;
if (msg.topic === "configuration") {
  state.configuration = msg.payload;
  if (state.windowOpen && !state.activeSettings) state.activeSettings = { ...msg.payload.values };
} else if (msg.topic === "available") {
  state.available = flag(msg.payload);
  if (state.available !== null) {
    const previous = state.lastAvailable;
    state.lastAvailable = state.available;
    availabilityChanged = previous !== state.available;
    if (state.available === false) {
      stopTimer();
      state.windowOpen = false;
      state.activeSettings = null;
      state.override = false;
      state.elapsed = 0;
    } else if (previous === false) beginWindow();
  }
} else if (msg.topic === "voltage") {
  const voltage = numeric(msg.payload);
  if (voltage !== null && voltage > 0) state.voltage = voltage;
} else if (msg.topic === "limit") {
  const previous = state.observedLimit;
  state.observedLimit = numeric(msg.payload);
  if (wasReady && state.mode === "ramping" && previous !== normalLimit && state.observedLimit === normalLimit && state.requestedLimit !== normalLimit) releaseInput();
  if (state.requestedLimit === normalLimit && state.observedLimit !== null && state.observedLimit !== normalLimit) state.sentLimit = null;
} else if (msg.topic === "ignore") {
  const previous = state.observedIgnore;
  state.observedIgnore = flag(msg.payload);
  if (wasReady && state.mode === "ramping" && previous === true && state.observedIgnore === false && state.requestedIgnore === true) releaseInput();
  if (state.requestedIgnore === false && state.observedIgnore === true && state.sentLimit === state.requestedLimit) ignore(false);
} else if (msg.topic === "soc") {
  state.soc = numeric(msg.payload);
} else if (msg.topic === "discharge") {
  const limit = numeric(msg.payload);
  state.dischargeAllowed = limit === null ? null : limit > 0;
} else if (msg.topic === "limit-write") {
  const pending = numeric(context.get("limitWrite"));
  const status = msg.status;
  if (pending !== null && status?.fill === "green" && status.shape === "dot" && (status.text == null || Number(status.text) === pending)) {
    context.set("limitWrite", null);
    state.sentLimit = pending;
  } else if (pending !== null && status?.fill === "red") {
    context.set("limitWrite", null);
    state.requestedLimit = normalLimit;
    state.sentLimit = null;
    state.override = state.windowOpen;
    state.mode = "override: normal input";
    ignore(false);
    node.error("Input limit write failed: " + status.text);
    save();
    return null;
  }
}
state.ready = !!state.configuration && state.dischargeAllowed === true && state.available !== null &&
  state.observedLimit !== null && state.observedIgnore !== null;
if (state.dischargeAllowed === false && (state.windowOpen || state.requestedIgnore === true)) finishWindow();
if (!state.ready) {
  if (state.requestedIgnore === true || state.requestedLimit !== null && state.requestedLimit < normalLimit) {
    state.override = state.windowOpen;
    normalInput();
  }
  state.mode = "waiting";
} else if (!wasReady || availabilityChanged) applyAvailability();
if (msg.topic === "full") releaseInput();
else if (msg.topic === "throttle" && state.ready && state.available === true) {
  if (!state.windowOpen) beginWindow();
  state.override = false;
  applyRamp();
}
writeLimit();
if (!state.windowOpen && state.requestedLimit === normalLimit && state.requestedIgnore === false && state.sentLimit === normalLimit &&
    state.observedLimit === normalLimit && state.observedIgnore === false && numeric(context.get("limitWrite")) === null) {
  state.requestedLimit = null;
  state.requestedIgnore = null;
}
startTimer();
save();
return null;
