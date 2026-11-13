// Derived from www/editor.js of jayjojayson/hass-victron-vrm-api 2.0
// (commit 017c7dc0c6956c6602c5678f2b339a514257a1e1), Apache-2.0.
// Modified for the standalone victron-energy-card; license and attribution are in victron-energy-card.js.

import { css } from "./css-editor.js";
import * as libEditor from "./lib-editor.js";
import { withDefaults } from "./lib-venus.js";

export const EDITOR_TAG = "victron-energy-card-editor";

class VictronEnergyCardEditor extends HTMLElement {

    setConfig(config) {

        // When HA hands back the config we just emitted, keep the DOM: a full
        // re-render would drop focus, open panels and an open colour picker.
        let incomingJson = null;
        try { incomingJson = JSON.stringify(config); } catch (e) { /* not serialisable */ }
        const isEcho = this.shadowRoot && incomingJson !== null && incomingJson === this._lastEmittedConfig;

        // A config without `devices` renders the defaults in the card, so the
        // editor shows (and on the first change writes) the same defaults.
        this._config = withDefaults(config);
        if (isEcho) return;

        if (!this.shadowRoot) {

            this.attachShadow({ mode: "open" });

            // own tab buttons (HA no longer ships Shoelace tabs)
            this.shadowRoot.innerHTML = `
              <div id="tab-group" class="vrm-tabs">
                <button type="button" class="vrm-tab" data-tab="0" active></button>
                <button type="button" class="vrm-tab" data-tab="1"></button>
                <button type="button" class="vrm-tab" data-tab="2"></button>
                <button type="button" class="vrm-tab" data-tab="3"></button>
              </div>
              <div id="tab-panel" class="vrm-tab-panel">
                <div id="tab-content" class="content"></div>
              </div>
            `;

            const style = document.createElement("style");
            style.textContent = css();
            this.shadowRoot.prepend(style);

            this._currentTab = 0;
            this._currentSubTab = 0;

            libEditor.attachLinkClick(this.renderTabContent.bind(this), this);
        }

        this.renderTabContent();
    }

    updateTabLabels() {
        if (!this.shadowRoot) return;
        this.shadowRoot.querySelectorAll("#tab-group .vrm-tab").forEach((tab) => {
            const index = parseInt(tab.getAttribute("data-tab"), 10);
            tab.textContent = index === 0
                ? libEditor.t("tabs", "general")
                : `${libEditor.t("tabs", "column")} ${index}`;
        });
    }

    renderTabContent() {

        if (!this.shadowRoot || !this._config) return;

        this.updateTabLabels();

        if (this._currentTab === 1 || this._currentTab === 2 || this._currentTab === 3) {
            libEditor.tabColRender(this._currentTab, this);
        } else {
            libEditor.tab1Render(this);
        }

        libEditor.attachInputs(this);
    }

    set hass(hass) {
        const first = !this._hass;
        this._hass = hass;
        if (!this.shadowRoot) return;

        this.shadowRoot.querySelectorAll("ha-selector, ha-icon-picker").forEach((el) => {
            el.hass = hass;
        });

        if (this._config && first) this.renderTabContent();
    }

    get hass() {
        return this._hass;
    }
}

if (!customElements.get(EDITOR_TAG)) {
    customElements.define(EDITOR_TAG, VictronEnergyCardEditor);
}
