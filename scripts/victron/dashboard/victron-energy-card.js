// Derived from www/victron-vrm-api.js of jayjojayson/hass-victron-vrm-api 2.0
// (commit 017c7dc0c6956c6602c5678f2b339a514257a1e1), Apache-2.0.
// Modified into the standalone, integration-agnostic victron-energy-card;
// changes are listed in NOTICE.
//
// Venus OS GUI v2 style power-flow card. Reads hass.states and the recorder
// history only. Tapping a box opens Home Assistant's more-info dialog for the
// box's control_entity (or its reading); the card never calls a service.

import { EDITOR_TAG } from "./editor.js";
import * as libVenus from "./lib-venus.js";
import { cssDataDark } from "./css-dark.js";
import { cssDataLight } from "./css-light.js";

const CARD_TAG = "victron-energy-card";
const HISTORY_REFRESH_MS = 15 * 60 * 1000;

// Element-level rules shared by both themes (the card renders in its own shadow root).
const HOST_CSS = `
    :host { display: block; container-type: inline-size; }
    .content[role="button"] { cursor: pointer; outline: none; }
    .content[role="button"]:focus-visible { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); border-radius: 4px; }
`;

const COMPACT_CSS = `
    @container (max-width: 600px) {
        ha-card .db-container { padding-bottom: 95%; }
        ha-card .dashboard { padding: 12px 8px; gap: 6%; }
        ha-card .column-1, ha-card .column-3 { width: 26%; }
        ha-card .column-2 { width: 36%; }
        ha-card .box { margin: 3px; padding: 8px 4px; }
        ha-card .boxFooter { flex-wrap: wrap; row-gap: 3px; }
        ha-card .footerCell { width: auto; flex: 1 1 auto; }
        ha-card .graph { bottom: 25%; }
    }
`;

class VictronEnergyCard extends HTMLElement {

    constructor() {
        super();
        this._isDark = true;
        this._appliedThemeKey = undefined;
        this._resizeObserver = null;

        // History is private to this card instance. _historyGen invalidates
        // in-flight requests whenever the card is reset or detached.
        this._history = new Map();
        this._historyVersion = 0;
        this._historyKey = "";
        this._historyGen = 0;
        this._historyTimer = null;
    }

    setConfig(config) {

        if (!config || typeof config !== "object" || Array.isArray(config)) {
            throw new Error("victron-energy-card: configuration must be a mapping");
        }
        const devices = config.devices;
        if (devices !== undefined && devices !== null && (typeof devices !== "object" || Array.isArray(devices))) {
            throw new Error("victron-energy-card: devices must map box ids such as \"1-1\" to boxes");
        }

        this.config = libVenus.withDefaults(config);

        // Keep the fetched history when only presentation changed; reset it
        // (and drop pending responses) when the set of graphed entities changed.
        const historyKey = libVenus.graphEntities(this.config).join(",");
        if (historyKey !== this._historyKey) {
            this._stopHistory();
            this._historyKey = historyKey;
            this._history = new Map();
            this._historyVersion++;
        }

        if (this.content) libVenus.stopAnimations(this.content);
        this._createCardStructure();

        this._render();
        this._ensureHistory();
    }

    _createCardStructure() {

        if (!this.content) {
            const root = this.attachShadow({ mode: "open" });

            const cardElem = document.createElement("ha-card");
            root.appendChild(cardElem);

            this._themeStyle = document.createElement("style");
            cardElem.appendChild(this._themeStyle);

            const contElem = document.createElement("div");
            contElem.className = "db-container";
            cardElem.appendChild(contElem);

            this.content = contElem;
            this._observeResize();
        }

        const param = this.config.param || {};

        libVenus.baseRender(this.content);
        libVenus.addBox(
            libVenus.getBoxCount(param, 1),
            libVenus.getBoxCount(param, 2),
            libVenus.getBoxCount(param, 3),
            this.content,
        );
        libVenus.addAnchors(this.config, this.content);
    }

    // Lines are positioned from measured anchor rectangles, so any size change
    // (desktop ↔ 390 px mobile, sidebar, sections) redraws them even when no
    // Home Assistant state changes. Auto font sizes are recomputed as well.
    _observeResize() {
        if (this._resizeObserver || !this.content || !this.isConnected) return;
        this._resizeObserver = new ResizeObserver(() => {
            libVenus.razDashboardOldWidth(this.content);
            this._render();
        });
        this._resizeObserver.observe(this.content);
    }

    set hass(hass) {
        this._hass = hass;
        this._render();
        this._ensureHistory();
    }

    get hass() {
        return this._hass;
    }

    _render() {

        const hass = this._hass;
        if (!hass || !this.config || !this.content || !this.isConnected) return;

        this._applyTheme(hass);

        libVenus.fillBox(this.config, this._isDark, hass, this.content, this._history, this._historyVersion);

        // redraws lines on width change or after a reset
        libVenus.checkReSize(this.config, this._isDark, this.content);

        // start, stop or reverse each flow from its signal
        libVenus.checkForReverse(this.config, hass, this.content);
    }

    _applyTheme(hass) {

        const isDarkTheme = !!hass.themes?.darkMode;
        const colors = this.config.colors && typeof this.config.colors === "object" ? this.config.colors : {};
        const color = (key) => libVenus.safeColor(colors[key]);
        const theme = this.config.theme || "auto";

        const themeKey = JSON.stringify([theme, isDarkTheme, colors]);
        if (themeKey === this._appliedThemeKey) return;
        this._appliedThemeKey = themeKey;

        // Overrides from the editor colour pickers (validated by safeColor)
        const colorOverrides = `
            ha-card {
                ${color("boxShadow") ? `--box-shadow-color: ${color("boxShadow")};` : ""}
                ${color("anchor") ? `--anchor-color: ${color("anchor")};` : ""}
            }
            ${color("graph") ? `.line g path { stroke: ${color("graph")} !important; }` : ""}
            ${color("ball") ? `.ball { fill: ${color("ball")} !important; }` : ""}
            ${color("textMain") ? `.boxSensor1, .boxSensor1 * { color: ${color("textMain")} !important; }` : ""}
            ${color("textSub") ? `.boxSensor2, .boxSensor2 *, .headerEntity, .headerEntity *, .boxTitle, .boxTitle * { color: ${color("textSub")} !important; }` : ""}
        `;

        let cssText;
        if (theme === "transparent") {
            cssText = (isDarkTheme ? cssDataDark() : cssDataLight()) + `
                ha-card { background: transparent !important; box-shadow: none !important; }
                .dashboard { background-color: transparent !important; }
            `;
            this._isDark = isDarkTheme;
        } else if (theme === "dark" || (theme === "auto" && isDarkTheme)) {
            cssText = cssDataDark();
            this._isDark = true;
        } else {
            cssText = cssDataLight();
            this._isDark = false;
        }

        this._themeStyle.textContent = HOST_CSS + cssText + colorOverrides + COMPACT_CSS;

        // ball gradient depends on the theme → redraw the lines
        libVenus.razDashboardOldWidth(this.content);
    }

    _ensureHistory() {
        if (this._historyTimer !== null || !this._historyKey || !this._hass || !this.isConnected) return;
        if (typeof this._hass.callApi !== "function") return;
        this._historyTimer = setInterval(() => this._loadHistory(), HISTORY_REFRESH_MS);
        this._loadHistory();
    }

    _stopHistory() {
        if (this._historyTimer !== null) clearInterval(this._historyTimer);
        this._historyTimer = null;
        this._historyGen++;
    }

    async _loadHistory() {
        const gen = this._historyGen;
        const entityIds = this._historyKey.split(",");
        let series;
        try {
            series = await libVenus.fetchHistory(this._hass, entityIds);
        } catch (error) {
            // the next interval retries; a stale failure is not reported
            if (gen === this._historyGen) console.warn("victron-energy-card: history unavailable", error);
            return;
        }
        // reset, reconfigured or detached meanwhile: discard
        if (gen !== this._historyGen) return;

        for (const id of entityIds) {
            if (series.has(id)) this._history.set(id, series.get(id));
            else this._history.delete(id);
        }
        this._historyVersion++;
        this._render();
    }

    static getConfigElement() {
        return document.createElement(EDITOR_TAG);
    }

    static getStubConfig() {
        return libVenus.getDefaultConfig();
    }

    // height ≈ 60 % of the width → about 6 masonry units
    getCardSize() {
        return 6;
    }

    // sections dashboard: full width by default
    getGridOptions() {
        return { columns: 12, min_columns: 6 };
    }

    connectedCallback() {
        this._observeResize();
        if (this.content) libVenus.razDashboardOldWidth(this.content);
        this._render();
        this._ensureHistory();
    }

    disconnectedCallback() {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        if (this.content) libVenus.stopAnimations(this.content);
        this._stopHistory();
    }
}

if (!customElements.get(CARD_TAG)) {
    customElements.define(CARD_TAG, VictronEnergyCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TAG)) {
    window.customCards.push({
        type: CARD_TAG,
        name: "Victron Energy Card",
        preview: true,
        description: "Venus OS GUI v2 style power flow for any Home Assistant entities.",
    });
}
