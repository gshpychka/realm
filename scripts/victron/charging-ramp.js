const stepSeconds = Number(env.get("RAMP_STEP_SECONDS"));
const minimumOutageMs = Number(env.get("MINIMUM_OUTAGE_SECONDS")) * 1000;
const outageMarginSeconds = Number(env.get("OUTAGE_MARGIN_SECONDS"));
const assumedChargingPowerW = Number(env.get("ASSUMED_CHARGING_POWER_W"));
const consumptionWindowSeconds = Number(env.get("CONSUMPTION_WINDOW_SECONDS"));
const normalLimit = Number(env.get("NORMAL_INPUT_CURRENT_A"));
const nominalVoltage = Number(env.get("NOMINAL_INPUT_VOLTAGE_V"));
const state = flow.get("gridRamp") || {
  available: null, lastAvailable: null, outageStartedAt: null, voltage: nominalVoltage,
  observedLimit: null, observedIgnore: null, requestedLimit: null, sentLimit: null,
  requestedIgnore: null, requestedPower: null, ready: false, dischargeAllowed: null,
  configuration: null, activeSettings: null, override: false, soc: null,
  nextOutageAt: null, scheduleReceivedAt: null, chargeDeadlineAt: null, windowDuration: null,
  completionReason: null, completedAt: null,
  windowOpen: false, elapsed: 0, mode: "waiting",
};
const numeric = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const flag = value => value === 1 || value === true ? true : value === 0 || value === false ? false : null;
const settings = () => state.activeSettings || state.configuration?.values;
const enabled = () => state.configuration?.values.enabled !== false;
const duration = () => state.windowOpen && numeric(state.windowDuration) !== null ? state.windowDuration : (settings()?.duration_minutes || 0) * 60;
const gridImportW = () => state.available === false || state.observedIgnore === true ? 0 : numeric(state.gridPower);
function forecastDataReason() {
  if (numeric(state.soc) === null || state.soc < 0 || state.soc > 100) return "Battery SOC unavailable";
  if (!(state.batteryCapacity > 0) || !(state.batteryVoltage > 0) || numeric(state.batteryCapacity * state.batteryVoltage) === null) return "Battery capacity or voltage unavailable";
  if (numeric(state.batteryPower) === null || gridImportW() === null ||
      numeric(gridImportW() - state.batteryPower) === null) return "Battery or grid power unavailable";
  if (state.available === null) return "Grid availability unknown";
  if (numeric(assumedChargingPowerW) === null || !(assumedChargingPowerW > 0) ||
      numeric(consumptionWindowSeconds) === null || !(consumptionWindowSeconds > 0) ||
      numeric(normalLimit * state.voltage) === null || !(normalLimit * state.voltage > 0)) return "Forecast configuration unavailable";
  if (state.available === false && !(state.restorationAt > Date.now() / 1000)) return "Future restoration time unavailable";
  return null;
}
function clearForecast(reason) {
  state.forecast = null;
  state.forecastDirty = true;
  state.forecastReason = reason;
  state.rechargeSeconds = null;
}
function reassess(force = false) {
  const now = Date.now() / 1000;
  const reason = forecastDataReason();
  const measuredConsumption = gridImportW() - state.batteryPower;
  const pairValid = numeric(state.batteryPower) !== null && gridImportW() !== null &&
    state.available !== null && numeric(measuredConsumption) !== null;
  if (state.consumptionSampleAt == null || now - state.consumptionSampleAt >= 60) {
    const value = pairValid ? Math.max(0, measuredConsumption) : null;
    const samples = state.consumptionSamples || [];
    samples.push({ at: now, value });
    const cutoff = now - consumptionWindowSeconds;
    while (samples.length > 1 && samples[1].at <= cutoff) samples.shift();
    state.consumptionSamples = samples;
    state.consumptionSampleAt = now;
  }
  if (reason) { clearForecast(reason); return; }
  if (!force && !state.forecastDirty && state.forecastAssessedAt != null && now - state.forecastAssessedAt < 60) return;
  state.forecastAssessedAt = now;
  state.forecastDirty = false;
  const samples = state.consumptionSamples || [];
  let integral = 0, seconds = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const end = index + 1 < samples.length ? samples[index + 1].at : now;
    const weight = Math.max(0, end - Math.max(now - consumptionWindowSeconds, sample.at));
    if (sample.value !== null) { integral += sample.value * weight; seconds += weight; }
  }
  const consumptionW = seconds > 0 ? integral / seconds :
    Math.max(0, measuredConsumption);
  let ramp = null;
  if (enabled() && state.available === true && state.ready && state.windowOpen && !state.override && state.activeSettings) {
    ramp = { startAt: now - state.elapsed, duration: duration(), solveAt: now,
      startA: state.activeSettings.start_current_a, targetA: state.activeSettings.target_current_a };
  } else if (enabled() && state.available === false && state.dischargeAllowed === true && state.configuration &&
      state.outageStartedAt != null && (state.restorationAt * 1000 - state.outageStartedAt) >= minimumOutageMs) {
    const configured = state.configuration.values;
    ramp = { startAt: state.restorationAt, duration: configured.duration_minutes * 60, solveAt: state.restorationAt,
      startA: configured.start_current_a, targetA: configured.target_current_a };
  }
  const nextOutageAt = state.nextOutageAt > now ? state.nextOutageAt : null;
  const nextDeadline = nextOutageAt === null ? null : nextOutageAt - outageMarginSeconds;
  if (!state.windowOpen && state.chargeDeadlineAt != null && state.chargeDeadlineAt + outageMarginSeconds <= now) state.chargeDeadlineAt = null;
  if (state.chargeDeadlineAt != null && nextDeadline !== null) state.chargeDeadlineAt = Math.min(state.chargeDeadlineAt, nextDeadline);
  const deadlineAt = state.chargeDeadlineAt ?? nextDeadline;
  const result = chargingForecast({ now, capacityWh: state.batteryCapacity * state.batteryVoltage,
    soc: state.soc, consumptionW, chargingPowerW: assumedChargingPowerW,
    normalPowerW: normalLimit * state.voltage, voltage: state.voltage,
    nextOutageAt, restorationAt: state.restorationAt ?? null,
    deadlineAt, available: state.available, ramp });
  if (ramp && state.available === true) {
    state.windowDuration = Math.min(duration(), result.duration);
    state.deadlineLimited = result.duration <= state.elapsed;
  }
  state.forecast = result.forecast;
  state.forecastReason = result.reason;
  state.rechargeSeconds = result.rechargeSeconds;
  return true;
}
function save() {
  flow.set("gridRamp", state);
  const active = settings(), configured = state.configuration?.values;
  const labels = { disabled: "Off", ramping: "Ramping", "normal input": "Normal input", "override: normal input": "Input override", "outage: ramp armed": "No grid power" };
  node.status({ fill: state.ready ? "green" : "yellow", shape: "dot", text: state.mode });
  node.send([null, null, { payload: {
    state: labels[state.mode] || "Waiting for data", phase: state.mode,
    enabled: configured?.enabled ?? null,
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
    next_outage_at: state.nextOutageAt ?? null, charge_deadline_at: state.chargeDeadlineAt ?? null,
    schedule_received_at: state.scheduleReceivedAt ?? null,
    completion_reason: state.completionReason ?? null,
    recharge_seconds: state.rechargeSeconds ?? null,
    forecast: state.forecast ?? null, forecast_reason: state.forecastReason ?? null,
    restoration_at: state.restorationAt ?? null, cycle_started_at: state.cycleStartedAt ?? null,
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
function finishWindow(reason = null) {
  stopTimer();
  state.completionReason = reason;
  state.completedAt = Date.now() / 1000;
  state.windowOpen = false;
  state.override = false;
  state.activeSettings = null;
  state.windowDuration = null;
  state.mode = enabled() ? "normal input" : "disabled";
  normalInput();
  reassess(true);
}
function beginWindow() {
  if (!enabled()) return;
  state.windowOpen = true;
  state.forecastDirty = true;
  state.completionReason = null;
  state.elapsed = 0;

  state.deadlineLimited = false;
  state.override = false;
  state.activeSettings = state.configuration ? { ...state.configuration.values } : null;
  state.windowDuration = state.activeSettings ? state.activeSettings.duration_minutes * 60 : null;
  state.chargeDeadlineAt = state.nextOutageAt == null ? null : state.nextOutageAt - outageMarginSeconds;
}
function releaseInput() {
  if (!state.windowOpen || state.available !== true || state.elapsed >= duration()) return finishWindow();
  state.override = true;
  state.forecastDirty = true;
  state.mode = "override: normal input";
  normalInput();
}
function applyRamp() {
  if (!enabled() || !state.ready || state.available !== true || !state.windowOpen || state.override || !state.activeSettings) return;
  reassess();
  if (state.chargeDeadlineAt != null && state.forecast === null) return finishWindow("forecast unavailable");
  if (state.deadlineLimited || state.elapsed >= duration()) return finishWindow("charge deadline");
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
  if (!enabled() || context.get("timer") || !state.windowOpen || !state.activeSettings) return;
  context.set("timer", setInterval(() => {
    state.elapsed = Math.min(duration(), state.elapsed + stepSeconds);
    if (state.elapsed >= duration()) finishWindow(duration() < state.activeSettings.duration_minutes * 60 ? "charge deadline" : null);
    else applyRamp();
    reassess();
    save();
  }, stepSeconds * 1000));
}
function applyAvailability() {
  if (!enabled()) return finishWindow();
  if (state.available === false) {
    state.mode = "outage: ramp armed";
    state.requestedPower = 0;
    state.requestedLimit = null;
    ignore(true);
  } else if (state.override) releaseInput();
  else if (state.windowOpen) applyRamp();
  else { state.mode = "normal input"; normalInput(); }
}
const measurementFields = { "battery-capacity": "batteryCapacity", "battery-voltage": "batteryVoltage",
  "battery-power": "batteryPower", "grid-power": "gridPower" };
if (Object.prototype.hasOwnProperty.call(measurementFields, msg.topic)) {
  state[measurementFields[msg.topic]] = numeric(msg.payload);
  const reason = forecastDataReason();
  if (reason) clearForecast(reason);
  flow.set("gridRamp", state);
  return null;
}
const wasReady = state.ready;
const wasEnabled = enabled();
let availabilityChanged = false;
if (msg.topic === "configuration") {
  if (JSON.stringify(state.configuration) !== JSON.stringify(msg.payload)) state.forecastDirty = true;
  state.configuration = msg.payload;
  if (state.windowOpen && !state.activeSettings) state.activeSettings = { ...msg.payload.values };
} else if (msg.topic === "available") {
  const available = flag(msg.payload);
  if (state.available !== available) state.forecastDirty = true;
  state.available = available;
  if (state.available !== null) {
    const previous = state.lastAvailable;
    state.lastAvailable = state.available;
    availabilityChanged = previous !== state.available;
    if (state.available === false) {
      if (state.outageStartedAt == null) {
        state.outageStartedAt = Date.now();
      }
      state.cycleStartedAt = state.outageStartedAt / 1000;
      stopTimer();
      state.windowOpen = false;
      state.activeSettings = null;
      state.windowDuration = null;
      state.chargeDeadlineAt = null;
      state.override = false;
      state.elapsed = 0;
    } else {
      if (previous === false && state.outageStartedAt != null && Date.now() - state.outageStartedAt >= minimumOutageMs) beginWindow();
      state.outageStartedAt = null;
    }
  }
} else if (msg.topic === "schedule") {
  const schedule = msg.payload;
  const validTime = value => value === null || numeric(value) !== null && value > 0;
  if (schedule && validTime(schedule.next_outage_at) && validTime(schedule.restoration_at)) {
    const next = schedule.next_outage_at;
    if (state.nextOutageAt !== next || state.restorationAt !== schedule.restoration_at) state.forecastDirty = true;
    state.nextOutageAt = next;
    state.restorationAt = schedule.restoration_at;
    state.scheduleReceivedAt = Date.now() / 1000;
    if (state.windowOpen && next !== null) {
      const deadline = next - outageMarginSeconds;
      state.chargeDeadlineAt = state.chargeDeadlineAt == null ? deadline : Math.min(state.chargeDeadlineAt, deadline);
    }
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
    state.mode = enabled() ? "override: normal input" : "disabled";
    ignore(false);
    node.error("Input limit write failed: " + status.text);
    reassess(true);
    save();
    return null;
  }
}
state.ready = !!state.configuration && state.dischargeAllowed === true && state.available !== null &&
  state.observedLimit !== null && state.observedIgnore !== null;
if (wasReady !== state.ready) state.forecastDirty = true;
if (state.dischargeAllowed === false && (state.windowOpen || state.requestedIgnore === true)) finishWindow();
if (state.configuration && !enabled()) {
  if (wasEnabled || state.windowOpen || state.requestedIgnore === true) finishWindow();
  state.mode = "disabled";
} else if (!state.ready) {
  if (state.requestedIgnore === true || state.requestedLimit !== null && state.requestedLimit < normalLimit) {
    state.override = state.windowOpen;
    normalInput();
  }
  state.mode = "waiting";
} else if (!wasReady || availabilityChanged || wasEnabled !== enabled()) applyAvailability();
if (msg.topic === "full") releaseInput();
else if (msg.topic === "throttle" && enabled() && state.ready && state.available === true) {
  if (!state.windowOpen) beginWindow();
  if (state.override) state.forecastDirty = true;
  state.override = false;
  applyRamp();
}
const forecastChanged = reassess();
if (forecastChanged && state.windowOpen && !state.override && state.ready && state.available === true) applyRamp();
writeLimit();
if (!state.windowOpen && state.requestedLimit === normalLimit && state.requestedIgnore === false && state.sentLimit === normalLimit &&
    state.observedLimit === normalLimit && state.observedIgnore === false && numeric(context.get("limitWrite")) === null) {
  state.requestedLimit = null;
  state.requestedIgnore = null;
}
startTimer();
save();
return null;
