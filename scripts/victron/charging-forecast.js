// Battery power is positive while charging. The charging assumption is not an actuator limit.
function chargingForecast(model) {
  const { now, capacityWh, soc, consumptionW, chargingPowerW, normalPowerW,
    nextOutageAt, restorationAt, deadlineAt, available, ramp } = model;
  const fullWh = capacityWh;
  const initialWh = soc / 100 * fullWh;
  const normalBatteryW = Math.min(chargingPowerW, normalPowerW - consumptionW);
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

  function simulate(duration, endAt, collect = false) {
    let at = now, energy = initialWh, fullAt = soc >= 100 ? now : null;
    let emptyAt = null, deadlineSoc = deadlineAt === now ? soc : null;
    const points = [];
    const add = (time, wh, power) => {
      if (collect) points.push([time, Math.max(0, Math.min(100, wh / fullWh * 100)), power]);
    };
    add(at, energy, allowance(at, duration));
    while (at < endAt - epsilon) {
      const power = allowance(at, duration);
      const batteryW = Math.min(chargingPowerW, power - consumptionW);
      let until = endAt;
      for (const transition of [restorationAt, deadlineAt, nextOutageAt,
        ramp ? ramp.startAt : null, ramp ? ramp.startAt + duration : null]) {
        if (transition != null && transition > at + epsilon) until = Math.min(until, transition);
      }
      if (ramp && duration > 0 && at >= ramp.startAt && at < ramp.startAt + duration) {
        until = Math.min(until, ramp.startAt + (Math.floor((at - ramp.startAt + epsilon) / 60) + 1) * 60);
      } else if (collect) until = Math.min(until, at + 900);
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
      add(at, energy, allowance(at, duration));
    }
    return { energy, emptyAt, fullAt, deadlineSoc, points };
  }

  let duration = ramp ? ramp.duration : 0;
  const budgetEnd = Math.max(now, deadlineAt ?? now, nextOutageAt ?? now);
  const reachesDeadline = result => result.emptyAt === null && result.fullAt !== null && result.fullAt <= deadlineAt + epsilon;
  const immediate = deadlineAt != null && deadlineAt >= now ? simulate(0, budgetEnd) : null;
  const shortfall = immediate !== null && !reachesDeadline(immediate);
  if (ramp && deadlineAt != null) {
    duration = 0;
    // Falling ramps are not monotone in duration; the bounded scan covers both slopes.
    const maxMinutes = Math.min(1440, Math.floor((ramp.startAt + ramp.duration - ramp.solveAt) / 60));
    if (!shortfall && deadlineAt >= now) {
      for (let minutes = maxMinutes; minutes >= 1; minutes--) {
        const candidate = ramp.solveAt - ramp.startAt + minutes * 60;
        const result = simulate(candidate, budgetEnd);
        if (reachesDeadline(result)) {
          duration = candidate;
          break;
        }
      }
    }
  }

  const horizon = Math.min(now + 48 * 3600,
    nextOutageAt != null && nextOutageAt > now ? nextOutageAt :
      Math.max(now + 6 * 3600, !available && restorationAt != null ? restorationAt + 6 * 3600 : now));
  const result = simulate(duration, horizon, true);
  // A full battery followed by a discharge is not the final recharge completion.
  const forecast = {
    generated_at: now, consumption_w: consumptionW, charging_power_w: chargingPowerW,
    capacity_wh: capacityWh, charge_deadline_at: deadlineAt, next_outage_at: nextOutageAt,
    restoration_at: restorationAt, ramp_start_at: ramp && duration > 0 ? ramp.startAt : null,
    ramp_end_at: ramp && duration > 0 ? ramp.startAt + duration : null,
    full_at: result.fullAt, soc_at_deadline: result.deadlineSoc,
    points: result.points.filter((point, index, points) => index === 0 ||
      point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1] || point[2] !== points[index - 1][2]),
  };
  return {
    forecast, duration, shortfall,
    reason: result.emptyAt !== null ? "Battery empty before forecast ends" : shortfall ? "Cannot reach full by charge deadline" : null,
    rechargeSeconds: soc >= 100 ? 0 : normalBatteryW > 0 ? (fullWh - initialWh) / normalBatteryW * 3600 : null,
  };
}
