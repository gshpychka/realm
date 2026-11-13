/*
Third-party source: Victron VRM API for Home Assistant by jayjojayson
https://github.com/jayjojayson/hass-victron-vrm-api
Revision: 017c7dc0c6956c6602c5678f2b339a514257a1e1 (integration version 2.0).
The upstream frontend identifies Venus-OS-Dashboard-Card as its base.
The standalone card, editor, themes and English labels are modified copies.

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

// Derived from www/victron-vrm-api.js of jayjojayson/hass-victron-vrm-api 2.0
// (commit 017c7dc0c6956c6602c5678f2b339a514257a1e1), Apache-2.0.
// Modified into the standalone, integration-agnostic victron-energy-card;
// license and attribution are in victron-energy-card.js.
//
// Venus OS GUI v2 style power-flow card. Reads hass.states and the recorder
// history only. Tapping a box opens Home Assistant's more-info dialog for the
// box's control_entity (or its reading); the card never calls a service.

import { EDITOR_TAG } from "./editor.js";
import "./victron-system-card.js";
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
