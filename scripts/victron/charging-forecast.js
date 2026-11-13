// Battery power is positive while charging; model estimates never set native charging limits.
function chargingForecast(model) {
  const { now, capacityWh, soc, normalPowerW, nextOutageAt: scheduledOutageAt, restorationAt,
    deadlineAt: scheduledDeadlineAt, available, ramp, learning } = model;
  const horizonEnd = now + 48 * 3600;
  // Remote schedules impose an earlier conservative decision boundary.
  const nextOutageAt = scheduledOutageAt == null ? null : Math.min(scheduledOutageAt, horizonEnd);
  const deadlineAt = scheduledDeadlineAt == null ? null : Math.min(scheduledDeadlineAt, horizonEnd);
  const scheduleCapped = scheduledOutageAt > horizonEnd || scheduledDeadlineAt > horizonEnd || restorationAt > horizonEnd;
  const fullWh = capacityWh;
  const initialWh = soc / 100 * fullWh;
  const epsilon = 1e-7;
  function allowance(at, duration) {
    if (nextOutageAt != null && nextOutageAt > now && at >= nextOutageAt) return 0;
    if (!available && at < restorationAt) return 0;
    if (ramp && duration > 0 && at >= ramp.startAt && at < ramp.startAt + duration) {
      const elapsed = Math.floor((at - ramp.startAt + epsilon) / 60) * 60;
      return Math.min(normalPowerW, (ramp.startA + (ramp.targetA - ramp.startA) * elapsed / duration) * model.voltage);
    }
    return normalPowerW;
  }
  function simulate(duration, endAt, collect = false, riskW = 0) {
    endAt = Math.min(endAt, horizonEnd);
    let at = now, energy = initialWh, fullAt = soc >= 100 ? now : null;
    let emptyAt = null, deadlineSoc = deadlineAt === now ? soc : null;
    const points = [];
    const add = (time, wh, power) => {
      if (collect) points.push([time, Math.max(0, Math.min(100, wh / fullWh * 100)), power]);
    };
    add(at, energy, allowance(at, duration));
    // Minute steps plus the finite transition set bound each solve independently of timestamps.
    let steps = 0;
    while (at < endAt - epsilon && steps++ < 48 * 60 + 16) {
      const power = allowance(at, duration);
      const netW = Math.min(learning.chargingAt(energy / fullWh * 100), power - learning.consumptionAt(at)) - riskW;
      const directionWh = learning.capacityAh(netW >= 0 ? "charge" : "discharge") * model.batteryVoltage;
      const batteryW = netW * fullWh / directionWh;
      let until = Math.min(endAt, at + 60);
      for (const transition of [restorationAt, deadlineAt, nextOutageAt, collect ? now + 1800 : null,
        ramp ? ramp.startAt : null, ramp ? ramp.startAt + duration : null]) {
        if (transition != null && transition > at + epsilon) until = Math.min(until, transition);
      }
      if (ramp && duration > 0 && at >= ramp.startAt && at < ramp.startAt + duration) {
        until = Math.min(until, ramp.startAt + (Math.floor((at - ramp.startAt + epsilon) / 60) + 1) * 60);
      }
      const change = batteryW * (until - at) / 3600;
      if (batteryW < 0 && energy + change < -epsilon) {
        emptyAt = at + energy / -batteryW * 3600;
        add(emptyAt, 0, allowance(emptyAt, duration));
        energy = 0;
        fullAt = null;
        break;
      }
      if (batteryW < 0 && change < 0) fullAt = null;
      if (batteryW > 0 && energy < fullWh && energy + change >= fullWh) {
        fullAt = at + (fullWh - energy) / batteryW * 3600;
        add(fullAt, fullWh, allowance(fullAt, duration));
      }
      energy = Math.max(0, Math.min(fullWh, energy + change));
      at = until;
      if (deadlineAt != null && Math.abs(at - deadlineAt) < epsilon) deadlineSoc = energy / fullWh * 100;
      if (at >= endAt - epsilon || at === now + 1800 || at === deadlineAt || at === nextOutageAt ||
          at === restorationAt || ramp && at >= ramp.startAt && at <= ramp.startAt + duration ||
          at - points.at(-1)?.[0] >= 900) add(at, energy, allowance(at, duration));
    }
    return { energy, emptyAt, fullAt, deadlineSoc, points, complete: at >= endAt - epsilon };
  }
  let duration = ramp ? ramp.duration : 0;
  const budgetEnd = Math.max(now, deadlineAt ?? now, nextOutageAt ?? now);
  const reachesDeadline = result => result.complete && result.emptyAt === null && result.fullAt !== null && result.fullAt <= deadlineAt + epsilon;
  const immediate = deadlineAt != null && deadlineAt >= now ? simulate(0, budgetEnd, false, learning.riskW) : null;
  const shortfall = immediate !== null && !reachesDeadline(immediate);
  if (ramp && deadlineAt != null) {
    duration = 0;
    // Falling ramps are not monotone in duration; the bounded scan covers both slopes.
    const maxMinutes = Math.min(1440, Math.floor((ramp.startAt + ramp.duration - ramp.solveAt) / 60));
    if (!shortfall && deadlineAt >= now) {
      for (let minutes = maxMinutes; minutes >= 1; minutes--) {
        const candidate = ramp.solveAt - ramp.startAt + minutes * 60;
        if (reachesDeadline(simulate(candidate, budgetEnd, false, learning.riskW))) {
          duration = candidate;
          break;
        }
      }
    }
  }
  const horizon = Math.min(horizonEnd,
    nextOutageAt != null && nextOutageAt > now ? nextOutageAt :
      Math.max(now + 6 * 3600, !available && restorationAt != null ? restorationAt + 6 * 3600 : now));
  const result = simulate(duration, horizon, true);
  const risk = deadlineAt != null && deadlineAt >= now ? simulate(duration, budgetEnd, false, learning.riskW) : null;
  const normal = simulate(0, horizon);
  const forecast = {
    generated_at: now, consumption_w: learning.consumptionAt(now), charging_power_w: learning.chargingAt(soc),
    capacity_wh: capacityWh, charge_deadline_at: scheduledDeadlineAt, next_outage_at: scheduledOutageAt,
    simulation_end_at: horizon, schedule_capped: scheduleCapped,
    restoration_at: restorationAt, ramp_start_at: ramp && duration > 0 ? ramp.startAt : null,
    ramp_end_at: ramp && duration > 0 ? ramp.startAt + duration : null,
    full_at: result.fullAt, soc_at_deadline: scheduledDeadlineAt === deadlineAt ? result.deadlineSoc : null,
    decision: { target_probability: learning.telemetry.target_probability,
      probability_calibrated: false, risk_mode: learning.telemetry.risk_mode,
      risk_power_w: learning.riskW, evaluated_deadline_at: deadlineAt,
      full_at: risk?.fullAt ?? null, soc_at_deadline: risk?.deadlineSoc ?? null },
    points: result.points.filter((point, index, points) => index === 0 ||
      point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1] || point[2] !== points[index - 1][2]),
  };
  return { forecast, duration, shortfall,
    reason: result.emptyAt !== null ? "Battery empty before forecast ends" : shortfall ? "Cannot reach full by charge deadline under decision model" :
      !result.complete ? "Forecast simulation work bound reached" : scheduleCapped ? "Remote schedule evaluated only through conservative 48-hour boundary" : null,
    rechargeSeconds: normal.fullAt === null ? null : normal.fullAt - now };
}
