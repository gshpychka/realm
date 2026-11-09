const defaults = Object.freeze({
  enabled: env.get("DEFAULT_ENABLED"),
  duration_minutes: Number(env.get("DEFAULT_DURATION_MINUTES")),
  start_current_a: Number(env.get("DEFAULT_START_CURRENT_A")),
  target_current_a: Number(env.get("DEFAULT_TARGET_CURRENT_A")),
});
const normalLimit = Number(env.get("NORMAL_INPUT_CURRENT_A"));
const filename = env.get("RAMP_SETTINGS_FILE");
const keys = Object.keys(defaults);
const numericKeys = keys.filter((key) => key !== "enabled");
function valid(values) {
  return values && typeof values.enabled === "boolean" && Number.isInteger(values.duration_minutes) &&
    values.duration_minutes >= 1 && values.duration_minutes <= 1440 &&
    [values.start_current_a, values.target_current_a].every((value) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= normalLimit);
}
if (!valid(defaults) || typeof filename !== "string" || !filename) {
  node.error("Grid-ramp defaults or settings location are invalid.", msg);
  return null;
}
if (msg.retain) return null;
let configuration = flow.get("configuration");
const key = msg.topic?.split("/").at(-1);
let missingFile = false;
let normalizedFile = false;
try {
  if (!configuration || key === "load") {
    let values;
    try {
      values = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missingFile = true;
      values = { ...defaults };
    }
    const saved = values;
    values = { ...defaults, ...saved };
    normalizedFile = keys.some((key) => saved[key] !== values[key]);
    if (!valid(values)) throw new Error("Saved grid-ramp settings are invalid");
    configuration = { values: Object.fromEntries(keys.map((key) => [key, values[key]])), defaults: { ...defaults } };
  }
  const values = { ...defaults, ...configuration.values };

  if (key === "reset") numericKeys.forEach((key) => { values[key] = defaults[key]; });
  else if (key === "enabled") values.enabled = msg.payload === "ON" ? true : msg.payload === "OFF" ? false : null;
  else if (keys.includes(key)) {
    const raw = msg.payload;
    values[key] = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  } else if (key !== "load") return null;
  if (!valid(values)) {
    node.warn("Grid-ramp settings require boolean enabled (ON/OFF), whole minutes (1–1440) and currents within the normal input limit.");
    return null;
  }
  const serialized = JSON.stringify(values, null, 2) + "\n";
  // Atomic replacement keeps the last complete settings across runtime restarts.
  if (missingFile || normalizedFile || !flow.get("configuration") || JSON.stringify(values) !== JSON.stringify(configuration.values)) {
    fs.writeFileSync(filename + ".tmp", serialized, { mode: 0o600 });
    fs.renameSync(filename + ".tmp", filename);
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (keys.some((key) => saved[key] !== values[key])) throw new Error("Settings readback differs");
  }
  configuration = { values, defaults: { ...defaults } };
  flow.set("configuration", configuration);
  node.status({ fill: "green", shape: "dot", text: `${values.duration_minutes} min; ${values.start_current_a}–${values.target_current_a} A` });
  return { topic: "configuration", payload: configuration };
} catch (error) {
  node.error(`Grid-ramp settings are unavailable: ${error.message}`, msg);
  return null;
}
