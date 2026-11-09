const METRICS = [
  ["battery_soc", "State of charge"],
  ["battery_power", "Battery power"],
  ["battery_voltage", "Voltage"],
  ["battery_current", "Current"],
  ["battery_temperature", "Temperature"],
  ["battery_health", "State of health"],
  ["battery_capacity", "Installed capacity"],
  ["battery_modules", "Modules online"],
  ["battery_remaining", "Estimated remaining time"],
  ["battery_charge_limit", "BMS charge-current limit"],
  ["battery_user_limit", "User charge-current ceiling"],
];

/** Read-only battery readings and native Recorder charts. */
export function openBatteryDetails(initialHass, entities, opener) {
  let hass = initialHass;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      dialog { width:min(860px,calc(100vw - 32px)); max-height:88vh; padding:0;
        border:1px solid var(--divider-color,#666); border-radius:16px;
        background:var(--primary-background-color,#fff); color:var(--primary-text-color,#222);
        font-family:var(--ha-font-family-body,system-ui); box-sizing:border-box; }
      dialog::backdrop { background:#0009; }
      header { display:flex; align-items:center; justify-content:space-between;
        position:sticky; top:0; z-index:2; padding:16px 20px;
        background:var(--primary-background-color,#fff); border-bottom:1px solid var(--divider-color,#ddd); }
      h2 { font-size:22px; margin:0; font-weight:500; }
      header button { border:0; background:none; color:inherit; font-size:28px;
        width:40px; height:40px; cursor:pointer; border-radius:50%; }
      main { padding:16px; }
      .metrics { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .metric { text-align:left; color:inherit; border:1px solid var(--divider-color,#ddd);
        background:var(--card-background-color,#fafafa); border-radius:10px;
        padding:12px; min-width:0; cursor:pointer; font:inherit; }
      .label { display:block; color:var(--secondary-text-color,#666); font-size:13px; margin-bottom:6px; }
      .value { display:block; font-size:19px; overflow-wrap:anywhere; }
      .history { margin-top:16px; min-width:0; }
      .history > * { display:block; margin-top:12px; }
      .status { font-size:14px; color:var(--secondary-text-color,#666); }
      @media(max-width:480px) { dialog { width:calc(100vw - 16px); max-height:94vh; }
        header { padding:10px 12px; } main { padding:10px; } .metric { padding:10px; }
        .value { font-size:17px; } }
    </style>
    <dialog aria-label="Battery details">
      <header><h2>Battery</h2><button type="button" aria-label="Close" autofocus>×</button></header>
      <main><div class="metrics"></div><div class="history"><p class="status">Loading history…</p></div></main>
    </dialog>`;
  const dialog = root.querySelector("dialog");
  const metricContainer = root.querySelector(".metrics");
  const cards = [];
  const values = new Map();
  for (const [key, label] of METRICS) {
    const entity = entities[key];
    if (!entity) continue;
    const button = document.createElement("button");
    button.className = "metric";
    button.type = "button";
    const caption = document.createElement("span");
    caption.className = "label";
    caption.textContent = label;
    const value = document.createElement("span");
    value.className = "value";
    button.append(caption, value);
    button.addEventListener("click", () => opener.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: entity }, bubbles: true, composed: true,
    })));
    metricContainer.append(button);
    values.set(key, value);
  }
  const update = (nextHass) => {
    hass = nextHass;
    for (const [key, element] of values) {
      const state = hass?.states?.[entities[key]];
      if (!state || ["unknown", "unavailable", ""].includes(state.state)) {
        element.textContent = "Unavailable";
      } else if (key === "battery_user_limit" && Number(state.state) === -1) {
        element.textContent = "Unrestricted";
      } else {
        element.textContent = typeof hass.formatEntityState === "function"
          ? hass.formatEntityState(state)
          : `${state.state} ${state.attributes?.unit_of_measurement || ""}`.trim();
      }
    }
    for (const card of cards) card.hass = hass;
  };
  const close = () => {
    if (dialog.open) dialog.close();
    host.remove();
    cards.length = 0;
    hass = null;
  };
  dialog.addEventListener("close", close, { once: true });
  root.querySelector("header button").addEventListener("click", close);
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  root.addEventListener("hass-more-info", (event) => {
    event.stopPropagation();
    opener.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: event.detail, bubbles: true, composed: true,
    }));
  });
  // Native charts receive theme and locale contexts from the HA view.
  opener.after(host);
  dialog.showModal();
  update(hass);
  (async () => {
    const history = root.querySelector(".history");
    try {
      const helpers = await window.loadCardHelpers();
      if (!dialog.open || !host.isConnected) return;
      const definitions = [
        { title: "State of charge · 24 hours", entities: [entities.battery_soc] },
        { title: "Power and current · 24 hours", entities: [entities.battery_power, entities.battery_current] },
      ];
      history.replaceChildren();
      for (const definition of definitions) {
        const selected = definition.entities.filter(Boolean);
        if (!selected.length) continue;
        const card = helpers.createCardElement({
          type: "history-graph", title: definition.title, entities: selected,
          hours_to_show: 24, refresh_interval: 60,
        });
        history.append(card);
        // Context consumers connect before the first history render.
        if (card.updateComplete) await card.updateComplete;
        if (!dialog.open || !host.isConnected) return;
        card.hass = hass;
        cards.push(card);
      }
    } catch {
      if (dialog.open) history.querySelector(".status")?.replaceChildren("History is unavailable.");
    }
  })();
  return { update, close, get open() { return dialog.open; } };
}
