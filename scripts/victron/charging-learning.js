// Only model statistics cross runtime restarts; observations and forecast checkpoints stay in memory.
function chargingLearning(state, now, options) {
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const blank = () => ({ version: 1, baselineAh: null, consumption: Array(24).fill(null),
    charging: Array(10).fill(null), chargeCapacity: null, dischargeCapacity: null,
    socErrors: [], completionErrors: [] });
  const validStat = value => value === null || value &&
    [value.mean, value.bias, value.noise, value.alpha].every(finite) &&
    value.mean >= 0 && value.noise >= 0 && value.alpha > 0 && value.alpha <= 0.15 &&
    Number.isInteger(value.count) && value.count > 0 && value.count <= 1000000;
  let memory = flow.get("chargingLearning");
  if (!memory) {
    let data = blank(), fileError = null;
    try {
      const saved = JSON.parse(fs.readFileSync(options.filename, "utf8"));
      if (saved.version !== 1 || ![saved.consumption, saved.charging].every(Array.isArray) ||
          saved.consumption.length !== 24 || saved.charging.length !== 10 ||
          ![...saved.consumption, ...saved.charging, saved.chargeCapacity, saved.dischargeCapacity].every(validStat) ||
          ![saved.socErrors, saved.completionErrors].every(values => Array.isArray(values) && values.length <= 128 && values.every(finite)) ||
          !(saved.baselineAh === null || finite(saved.baselineAh) && saved.baselineAh > 0)) throw new Error("Invalid learning statistics");
      data = saved;
    } catch (error) {
      if (error.code !== "ENOENT") { fileError = error.message; node.warn(`Charging learning starts from assumptions: ${error.message}`); }
    }
    memory = { data, fileError, lastWriteAt: data.consumption.some(Boolean) ? now : 0, dirty: false };
    flow.set("chargingLearning", memory);
  }
  const data = memory.data;
  function update(stat, value, initial, low, high) {
    stat = stat || { mean: initial, bias: 0, noise: 0, count: 0, alpha: low };
    const error = value - stat.mean;
    stat.bias += 0.1 * (error - stat.bias);
    stat.noise += 0.1 * (Math.abs(error) - stat.noise);
    // Consistent signed error speeds adaptation; alternating error keeps it slow.
    stat.alpha = low + (high - low) * clamp(Math.abs(stat.bias) / Math.max(1e-9, stat.noise), 0, 1);
    stat.mean += stat.alpha * error;
    stat.count = Math.min(1000000, stat.count + 1);
    memory.dirty = true;
    return stat;
  }
  function record(key, value) {
    data[key].push(clamp(value, -options.normalPowerW, options.normalPowerW));
    if (data[key].length > 128) data[key].shift();
    memory.dirty = true;
  }
  const health = finite(state.batteryHealth) && state.batteryHealth > 0 && state.batteryHealth <= 100 ? state.batteryHealth / 100 : 1;
  const baselineAh = state.batteryCapacity * health;
  if (finite(baselineAh) && baselineAh > 0 && (data.baselineAh === null || Math.abs(baselineAh / data.baselineAh - 1) > 0.02)) {
    data.baselineAh = baselineAh;
    data.chargeCapacity = null;
    data.dischargeCapacity = null;
    data.socErrors = [];
    data.completionErrors = [];
    memory.anchor = null;
    memory.previous = null;
    memory.checkpoint = null;
    memory.completion = null;
    memory.dirty = true;
  }
  const capacityAh = direction => clamp(data[direction === "charge" ? "chargeCapacity" : "dischargeCapacity"]?.mean ?? baselineAh, baselineAh * 0.5, baselineAh * 1.5);
  const slot = at => new Date(at * 1000).getUTCHours();
  const chargingAt = soc => clamp(data.charging[clamp(Math.floor(soc / 10), 0, 9)]?.mean ?? options.chargingPowerW, 100, options.normalPowerW);
  const fresh = key => finite(state.measurementAt?.[key]) && now - state.measurementAt[key] >= 0 && now - state.measurementAt[key] <= 180;
  const sourceMatches = state.batteryService === options.batteryService;
  const valid = options.decisionReady && sourceMatches && fresh("batteryService") && state.batteryConnected === 1 &&
    fresh("batteryConnected") && fresh("available") && fresh("soc") && fresh("batterySoc") && fresh("batteryCurrent") &&
    fresh("batteryVoltage") && fresh("batteryPower") && finite(options.consumptionW) &&
    finite(state.batteryPower) && finite(options.normalPowerW) && options.normalPowerW > 0 &&
    finite(state.soc) && state.soc >= 0 && state.soc <= 100 && finite(state.batterySoc) &&
    Math.abs(state.soc - state.batterySoc) <= 1 && finite(state.batteryCurrent) &&
    state.batteryVoltage > 0 && finite(baselineAh) && baselineAh > 0 &&
    (state.available === false || state.available === true && fresh("gridPower") &&
      fresh("observedIgnore") && fresh("observedLimit"));
  if (!valid) {
    memory.previous = null;
    memory.anchor = null;
    memory.checkpoint = null;
    memory.completion = null;
    memory.recentW = null;
  }
  const policy = () => JSON.stringify([state.windowOpen, state.windowDuration, state.override,
    state.activeSettings, state.configuration?.values.enabled, state.available,
    state.nextOutageAt, state.restorationAt, state.chargeDeadlineAt,
    state.windowOpen && !state.override ? null : [state.observedLimit, state.observedIgnore]]);
  if (memory.policy !== policy()) {
    memory.checkpoint = null;
    memory.completion = null;
    if (memory.previous) memory.previous.unrestricted = false;
  }
  const observationAt = options.observationAt;
  if (finite(observationAt) && (memory.sampleAt == null || observationAt - memory.sampleAt >= 30)) {
    const previous = memory.previous;
    const dt = previous ? observationAt - previous.at : 0;
    const continuous = valid && previous && dt >= 30 && dt <= 90 &&
      previous.available === state.available && previous.ignored === state.observedIgnore;
    let reset = false;
    if (continuous) {
      const deltaSoc = state.soc - previous.soc;
      const ah = (previous.current + state.batteryCurrent) / 2 * dt / 3600;
      const plausibleSoc = Math.abs(ah) / baselineAh * 100;
      reset = Math.abs(deltaSoc) > Math.max(2, plausibleSoc * 3 + 1) ||
        deltaSoc * ah < 0 && Math.abs(deltaSoc) > 1;
      if (!reset) {
        const observed = clamp(options.consumptionW, 0, options.normalPowerW * 2);
        const hour = slot(now);
        data.consumption[hour] = update(data.consumption[hour], observed, observed, 0.01, 0.15);
        memory.recentW = memory.recentW == null ? observed : memory.recentW +
          (1 - Math.exp(-dt / options.recentSeconds)) * (observed - memory.recentW);
        const unrestricted = state.available === true && state.observedIgnore === false &&
          fresh("gridCurrent") && fresh("batteryChargeLimit") &&
          finite(state.gridCurrent) && state.gridCurrent >= 0 && finite(state.batteryChargeLimit) &&
          !(state.windowOpen && !state.override) && state.observedLimit >= options.normalLimit - 0.1 &&
          state.gridCurrent < state.observedLimit - 1 && state.batteryCurrent > 2 &&
          state.batteryChargeLimit > state.batteryCurrent + 2 && state.soc < 99 &&
          state.batteryPower > 100 && Math.abs(state.batteryPower - state.batteryCurrent * state.batteryVoltage) < Math.max(200, state.batteryPower * 0.1);
        if (unrestricted && previous.unrestricted) {
          const band = clamp(Math.floor(state.soc / 10), 0, 9);
          if (band === previous.band) data.charging[band] = update(data.charging[band],
            clamp(state.batteryPower, 100, options.normalPowerW), options.chargingPowerW, 0.01, 0.12);
        }
        memory.unrestricted = unrestricted;
        const direction = state.batteryCurrent > 2 && previous.current > 2 ? "charge" :
          state.batteryCurrent < -2 && previous.current < -2 ? "discharge" : null;
        if (!direction || memory.anchor?.direction !== direction) memory.anchor = direction ? { direction, soc: previous.soc, ah: 0, at: previous.at } : null;
        const anchor = memory.anchor;
        if (anchor) {
          anchor.ah += ah;
          const span = state.soc - anchor.soc;
          if (now - anchor.at > 12 * 3600) memory.anchor = null;
          else if (Math.abs(span) >= 15 && now - anchor.at >= 900 && span * anchor.ah > 0) {
            const estimate = Math.abs(anchor.ah / span * 100);
            if (state.soc > 5 && state.soc < 95 && estimate >= baselineAh * 0.5 && estimate <= baselineAh * 1.5) {
              const key = direction === "charge" ? "chargeCapacity" : "dischargeCapacity";
              data[key] = update(data[key], estimate, baselineAh, 0.005, 0.03);
            }
            memory.anchor = null;
          }
        }
        if (memory.checkpoint && now >= memory.checkpoint.at) {
          if (now - memory.checkpoint.at <= 90) record("socErrors", (memory.checkpoint.soc - state.soc) / 100 * memory.checkpoint.capacityWh / 0.5);
          memory.checkpoint = null;
        }
        const watch = memory.completion;
        if (watch && state.soc >= 100) {
          const actualHours = (now - watch.startAt) / 3600;
          if (actualHours > 0) record("completionErrors", watch.neededWh * (1 / watch.expectedHours - 1 / actualHours));
          memory.completion = null;
        } else if (watch && now - watch.startAt > 12 * 3600) {
          // A censored late completion contributes its observed lower bound.
          record("completionErrors", watch.neededWh * (1 / watch.expectedHours - 1 / 12));
          memory.completion = null;
        }
      }
    }
    if (!continuous || reset) {
      memory.anchor = null;
      memory.checkpoint = null;
      memory.completion = null;
      memory.unrestricted = false;
      memory.recentW = valid && !reset ? options.consumptionW : null;
    }
    memory.previous = valid ? { at: observationAt, soc: state.soc, current: state.batteryCurrent,
      available: state.available, ignored: state.observedIgnore,
      unrestricted: memory.unrestricted, band: clamp(Math.floor(state.soc / 10), 0, 9) } : null;
    memory.sampleAt = observationAt;
  }
  if (memory.dirty && data.consumption.some(Boolean) && now - memory.lastWriteAt >= 900) {
    memory.lastWriteAt = now;
    try {
      fs.writeFileSync(options.filename + ".tmp", JSON.stringify(data) + "\n", { mode: 0o600 });
      fs.renameSync(options.filename + ".tmp", options.filename);
      if (fs.readFileSync(options.filename, "utf8").trim() !== JSON.stringify(data)) throw new Error("Learning readback differs");
      memory.dirty = false;
      memory.fileError = null;
    } catch (error) { memory.fileError = error.message; node.warn(`Charging learning save failed: ${error.message}`); }
  }
  const quantile = values => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length + 1) * options.probability) - 1)];
  };
  const sufficient = data.socErrors.length >= 20 && data.completionErrors.length >= 20;
  const riskW = sufficient ? clamp(Math.max(quantile(data.socErrors), quantile(data.completionErrors)), 0, options.normalPowerW) : 0;
  const recent = memory.recentW ?? options.consumptionW;
  const correction = recent - (data.consumption[slot(now)]?.mean ?? recent);
  const consumptionAt = at => {
    const profile = data.consumption[slot(at)];
    return clamp(profile ? profile.mean + correction * Math.exp(-Math.max(0, at - now) / options.recentSeconds) : recent, 0, options.normalPowerW * 2);
  };
  return {
    consumptionAt, chargingAt, capacityAh,
    riskW,
    telemetry: { source_matches: sourceMatches, observations_ready: valid, file_error: memory.fileError,
      consumption: data.consumption, charging: data.charging,
      charge_capacity_ah: data.chargeCapacity, discharge_capacity_ah: data.dischargeCapacity,
      baseline_ah: baselineAh, soc_error_samples: data.socErrors.length,
      completion_error_samples: data.completionErrors.length, target_probability: options.probability,
      probability_calibrated: false, risk_mode: sufficient ? "empirical residual quantile" : "bootstrap assumptions",
      risk_power_w: riskW },
    observe(forecast) {
      const observedPolicy = policy();
      if (memory.policy !== observedPolicy) {
        memory.checkpoint = null;
        memory.completion = null;
      }
      memory.policy = observedPolicy;
      if (!valid || !forecast) return;
      if (!memory.checkpoint) {
        const at = now + 1800;
        const points = forecast.points;
        const index = points.findIndex(point => point[0] >= at);
        if (index > 0 && Math.abs(points[index][1] - state.soc) >= 2) {
          const a = points[index - 1], b = points[index];
          memory.checkpoint = { at, soc: a[1] + (b[1] - a[1]) * (at - a[0]) / (b[0] - a[0]), capacityWh: forecast.capacity_wh };
        }
      }
      if (!memory.completion && state.soc <= 90 && forecast.full_at > now + 900 && forecast.full_at <= now + 6 * 3600) {
        memory.completion = { startAt: now, expectedHours: (forecast.full_at - now) / 3600,
          neededWh: (100 - state.soc) / 100 * forecast.capacity_wh };
      }
    },
  };
}
