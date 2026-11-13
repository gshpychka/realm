// Derived from www/lib-editor.js of jayjojayson/hass-victron-vrm-api 2.0
// (commit 017c7dc0c6956c6602c5678f2b339a514257a1e1), Apache-2.0.
// Modified for the standalone victron-energy-card; license and attribution are in victron-energy-card.js.
//
// Visual editor: general tab (theme, boxes per column, font sizes, colours,
// ball size) and one tab per column with a sub-tab per box (icon, name,
// entities, control entity, graph, gauge, footer, anchors, links).
// Entity selectors are unfiltered: any entity of any integration is accepted.

import en from "./lang-en.js";
import { esc, isTrue, parseAnchors, visibleBoxIds, ballSize, MIN_BALL_SIZE, MAX_BALL_SIZE } from "./lib-venus.js";

/* Event listeners already attached to an element (avoid duplicates) */
const eventHandlers = new WeakMap();

const DEFAULT_EXPANDED_PANELS = ["subPanel_header", "subPanel_entities", "subPanel_entities2"];
const LINK_ID = /^\d+$/;
const MAX_ANCHORS_PER_SIDE = 3;

/**************************************/
/* Translations                       */
/**************************************/
export function t(func, key) {
    return en?.[func]?.[key] || key;
}

/**
 * Labelled native <input>. HA 2026.10 removed ha-textfield, ha-radio and
 * ha-formfield; native inputs styled with HA theme variables work everywhere.
 */
function createField({ id, path, label, type = "text", value, min, max, step, group, disabled, className = "" }) {
    const wrapper = document.createElement("label");
    wrapper.className = `vrm-field ${className}`.trim();
    const span = document.createElement("span");
    span.className = "vrm-field-label";
    span.textContent = label ?? "";
    const input = document.createElement("input");
    input.className = "vrm-input";
    input.type = type;
    if (id) input.id = id;
    if (path) input.dataset.path = path;
    if (group) input.dataset.group = group;
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    if (step !== undefined) input.step = String(step);
    if (value !== undefined && value !== null) input.value = String(value);
    if (disabled) input.disabled = true;
    wrapper.appendChild(span);
    wrapper.appendChild(input);
    return wrapper;
}

/* ha-switch: attribute AND property (older and newer HA versions) */
function setSwitchChecked(sw, checked) {
    if (checked) sw.setAttribute("checked", "");
    else sw.removeAttribute("checked");
    try { sw.checked = !!checked; } catch (e) { /* ignore */ }
}

/* mark the active tab of a tab bar */
function setActiveTab(selector, index, appendTo) {
    appendTo.shadowRoot.querySelectorAll(selector).forEach((tab) => {
        if (parseInt(tab.getAttribute("data-tab"), 10) === index) tab.setAttribute("active", "");
        else tab.removeAttribute("active");
    });
}

function clampInt(value, min, max) {
    const n = parseInt(value, 10);
    if (isNaN(n)) return min;
    return Math.min(Math.max(n, min), max);
}

/***************************************/
/* General tab                         */
/***************************************/
export function tab1Render(appendTo) {

    const tabContent = appendTo.shadowRoot.querySelector("#tab-content");
    tabContent.innerHTML = "";

    const editorDiv = document.createElement("div");
    editorDiv.classList.add("editor");

    // Theme
    const themeRow = document.createElement("div");
    themeRow.classList.add("col");
    const themeLabel = document.createElement("div");
    themeLabel.classList.add("left");
    themeLabel.textContent = t("tab1Render", "theme_choice");
    const radioGroup = document.createElement("div");
    radioGroup.classList.add("radio-group", "row");
    const themeOptions = [
        { label: t("tab1Render", "light"), value: "light" },
        { label: t("tab1Render", "dark"), value: "dark" },
        { label: t("tab1Render", "auto"), value: "auto" },
        { label: t("tab1Render", "transparent"), value: "transparent" },
    ];

    const currentTheme = appendTo._config.theme || "auto";

    themeOptions.forEach((option) => {
        const formfield = document.createElement("label");
        formfield.classList.add("vrm-radio");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "themeSelect";
        radio.dataset.path = "theme";
        radio.value = option.value;
        if (currentTheme === option.value) radio.checked = true;
        const span = document.createElement("span");
        span.textContent = option.label;
        formfield.appendChild(radio);
        formfield.appendChild(span);
        radioGroup.appendChild(formfield);
    });

    themeRow.appendChild(themeLabel);
    themeRow.appendChild(radioGroup);
    editorDiv.appendChild(themeRow);

    // Boxes per column
    const devicesRow = document.createElement("div");
    devicesRow.classList.add("col");
    const devicesLabel = document.createElement("div");
    devicesLabel.classList.add("left");
    devicesLabel.textContent = t("tab1Render", "devices_per_column");

    const devicesInputs = [
        { id: "boxCol1", label: "col. 1", value: appendTo._config.param?.boxCol1 ?? 1, min: 1, max: 4 },
        { id: "boxCol2", label: "col. 2", value: appendTo._config.param?.boxCol2 ?? 1, min: 1, max: 2 },
        { id: "boxCol3", label: "col. 3", value: appendTo._config.param?.boxCol3 ?? 1, min: 1, max: 4 },
    ];

    const devicesRowContainer = document.createElement("div");
    devicesRowContainer.classList.add("row");
    devicesInputs.forEach((input) => {
        devicesRowContainer.appendChild(createField({
            id: input.id,
            path: `param.${input.id}`,
            label: input.label,
            type: "number",
            value: input.value,
            min: input.min,
            max: input.max,
            step: 1,
            className: "cell",
        }));
    });
    devicesRow.appendChild(devicesLabel);
    devicesRow.appendChild(devicesRowContainer);
    editorDiv.appendChild(devicesRow);

    // Font sizes retain numeric pixels or explicit CSS units.
    const fontSizeRow = document.createElement("div");
    fontSizeRow.classList.add("col");
    const fontSizeLabel = document.createElement("div");
    fontSizeLabel.classList.add("row");
    fontSizeLabel.textContent = t("tab1Render", "font_size_zones");
    fontSizeRow.appendChild(fontSizeLabel);

    const fontSizeSections = [
        { label: t("tab1Render", "in_header"), path: "header" },
        { label: t("tab1Render", "in_devices"), path: "sensor" },
        { label: t("tab1Render", "in_sensor2"), path: "sensor2" },
        { label: t("tab1Render", "in_footer"), path: "footer" },
    ];

    fontSizeSections.forEach((section) => {
        const sectionRow = document.createElement("div");
        sectionRow.classList.add("row");

        const labelCell = document.createElement("div");
        labelCell.classList.add("row", "cellx1-5");
        const labelText = document.createElement("div");
        labelText.classList.add("cell", "left");
        labelText.textContent = `- ${section.label}`;
        labelCell.appendChild(labelText);
        sectionRow.appendChild(labelCell);

        const inputCell = document.createElement("div");
        inputCell.classList.add("cell", "right");
        const styleValue = appendTo._config.styles?.[section.path];
        inputCell.appendChild(createField({
            id: section.path,
            path: `styles.${section.path}`,
            group: section.path,
            label: t("tab1Render", "font_size"),
            type: "text",
            value: styleValue && styleValue !== "auto" ? styleValue : undefined,
            disabled: styleValue === "auto",
        }));
        sectionRow.appendChild(inputCell);

        const switchCell = document.createElement("div");
        switchCell.classList.add("row", "cell");
        const switchContainer = document.createElement("div");
        switchContainer.classList.add("cell", "right");
        const fontSwitch = document.createElement("ha-switch");
        fontSwitch.setAttribute("data-path", `styles.${section.path}`);
        fontSwitch.setAttribute("data-group", section.path);
        setSwitchChecked(fontSwitch, styleValue === "auto");

        const autoLabel = document.createElement("span");
        autoLabel.classList.add("vrm-switch-label");
        autoLabel.textContent = t("tab1Render", "auto_size");
        switchContainer.appendChild(autoLabel);
        switchContainer.appendChild(fontSwitch);
        switchCell.appendChild(switchContainer);
        sectionRow.appendChild(switchCell);

        fontSizeRow.appendChild(sectionRow);
    });

    editorDiv.appendChild(fontSizeRow);

    // Colour pickers
    const colorsRow = document.createElement("div");
    colorsRow.classList.add("col");
    const colorsLabel = document.createElement("div");
    colorsLabel.classList.add("left");
    colorsLabel.textContent = t("tab1Render", "colors_title");
    colorsRow.appendChild(colorsLabel);

    const colorOptions = [
        { label: t("tab1Render", "box_shadow_color"), path: "colors.boxShadow", defaultDark: "#38619b", defaultLight: "#38619b" },
        { label: t("tab1Render", "anchor_color"),     path: "colors.anchor",    defaultDark: "#38619b", defaultLight: "#38619b" },
        { label: t("tab1Render", "graph_color"),      path: "colors.graph",     defaultDark: "#4369a2", defaultLight: "#4369a2" },
        { label: t("tab1Render", "history_color"),    path: "colors.history",   defaultDark: "#ffffff", defaultLight: "#000000" },
        { label: t("tab1Render", "ball_color"),       path: "colors.ball",      defaultDark: "#4369a2", defaultLight: "#4369a2" },
        { label: t("tab1Render", "text_main_color"),  path: "colors.textMain",  defaultDark: "#ffffff", defaultLight: "#484848" },
        { label: t("tab1Render", "text_sub_color"),   path: "colors.textSub",   defaultDark: "#aaaaaa", defaultLight: "#aaaaaa" },
    ];

    const makeColorRow = (opts) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;";
        opts.forEach((opt) => {
            const cell = document.createElement("div");
            cell.style.cssText = "display:flex;flex-direction:column;align-items:center;width:56px;flex-shrink:0;";
            const lbl = document.createElement("div");
            lbl.style.cssText = "font-size:0.75em;text-align:center;line-height:1.2;margin-bottom:3px;word-break:break-word;min-height:3em;display:flex;align-items:flex-end;justify-content:center;";
            lbl.textContent = opt.label;
            const [group, key] = opt.path.split(".");
            const currentVal = appendTo._config?.[group]?.[key];
            const input = document.createElement("input");
            input.type = "color";
            input.dataset.path = opt.path;
            input.style.cssText = "width:56px;height:32px;border:none;background:none;cursor:pointer;padding:0;box-sizing:border-box;";
            // <input type=color> only accepts #rrggbb; other configured colours show the default
            const isLight = appendTo._config?.theme === "light";
            input.value = /^#[0-9a-f]{6}$/i.test(currentVal ?? "") ? currentVal : (isLight ? opt.defaultLight : opt.defaultDark);
            cell.appendChild(lbl);
            cell.appendChild(input);
            row.appendChild(cell);
        });
        return row;
    };
    colorsRow.appendChild(makeColorRow(colorOptions.slice(0, 4)));
    colorsRow.appendChild(makeColorRow(colorOptions.slice(4)));
    editorDiv.appendChild(colorsRow);

    // Ball size
    const ballSizeRow = document.createElement("div");
    ballSizeRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-top:12px;";
    const ballSizeLbl = document.createElement("div");
    ballSizeLbl.classList.add("left");
    ballSizeLbl.textContent = t("tab1Render", "ball_size");
    ballSizeLbl.style.cssText = "flex-shrink:0;min-width:120px;";
    const ballSizeVal = document.createElement("span");
    ballSizeVal.style.cssText = "min-width:24px;text-align:right;font-weight:bold;";
    const currentBallSize = ballSize(appendTo._config.param);
    ballSizeVal.textContent = String(currentBallSize);
    const ballSizeInput = document.createElement("input");
    ballSizeInput.type = "range";
    ballSizeInput.min = String(MIN_BALL_SIZE);
    ballSizeInput.max = String(MAX_BALL_SIZE);
    ballSizeInput.step = "any";
    ballSizeInput.value = String(currentBallSize);
    ballSizeInput.dataset.path = "param.ballSize";
    ballSizeInput.style.cssText = "flex:1;cursor:pointer;";
    ballSizeInput.addEventListener("input", () => { ballSizeVal.textContent = ballSizeInput.value; });
    ballSizeRow.appendChild(ballSizeLbl);
    ballSizeRow.appendChild(ballSizeInput);
    ballSizeRow.appendChild(ballSizeVal);
    editorDiv.appendChild(ballSizeRow);

    tabContent.appendChild(editorDiv);
}

/**********************************************/
/* Column tab: one sub-tab per box            */
/**********************************************/
export function tabColRender(col, appendTo) {

    const maxBox = col === 2 ? 2 : 4;
    const boxCol = clampInt(appendTo._config.param?.[`boxCol${col}`] ?? 1, 1, maxBox);

    // the sub-tab must exist in this column
    if (typeof appendTo._currentSubTab !== "number" || appendTo._currentSubTab >= boxCol || appendTo._currentSubTab < 0) {
        appendTo._currentSubTab = 0;
    }

    const tabContent = appendTo.shadowRoot.querySelector("#tab-content");

    let tabsHTML = "";
    for (let i = 1; i <= boxCol; i++) {
        tabsHTML += `<button type="button" class="vrm-tab" data-tab="${i - 1}"${(i - 1) === appendTo._currentSubTab ? " active" : ""}>${col}-${i}</button>`;
    }

    tabContent.innerHTML = `
        <div class="devices-editor">
            <div id="subTab-group" class="vrm-tabs vrm-subtabs">
                ${tabsHTML}
            </div>
            <div id="subTab-content" class="subTab-content"></div>
        </div>
    `;

    attachSubLinkClick(appendTo);
    renderSubTabContent(col, appendTo);
}

export function renderSubTabContent(col, appendTo) {
    const boxId = `${col}-${appendTo._currentSubTab + 1}`;
    subtabRender(boxId, appendTo._config, appendTo._hass, appendTo);
    attachInputs(appendTo);
}

/* Entity selector without any domain or integration filter */
function setupEntitySelector(el, value, hass) {
    el.selector = { entity: {} };
    el.required = false;
    el.value = value ?? "";
    el.hass = hass;
}

/************************************************/
/* Box sub-tab                                  */
/************************************************/
export function subtabRender(box, config, hass, appendTo) {

    const subTabContent = appendTo.shadowRoot.querySelector("#subTab-content");
    const device = config?.devices?.[box] || {};

    const perSide = { L: 0, T: 0, B: 0, R: 0 };
    const thisAllAnchors = [];
    parseAnchors(device.anchors).forEach(({ type, qty }) => {
        perSide[type] = qty;
        for (let i = 1; i <= qty; i++) thisAllAnchors.push(`${type}-${i}`);
    });
    thisAllAnchors.sort();

    const otherAllAnchors = getAllAnchorsExceptCurrent(config, box);

    const tx = (key) => esc(t("subtabRender", key));
    const anchorInput = (id, qty) => `
        <input class="anchor" type="number" id="${id}"
            data-path="devices.${box}.anchors"
            value="${qty}" min="0" max="${MAX_ANCHORS_PER_SIDE}" step="1"
            style="width:100%;padding:6px 4px;background:var(--card-background-color,#1c2536);color:var(--primary-text-color);border:1px solid var(--divider-color,#404040);border-radius:4px;text-align:center;"
        >`;
    const anchorLabel = (key, extra = "") =>
        `<label style="font-size:0.85em;color:var(--secondary-text-color);${extra}">${tx(key)}</label>`;
    const footerAlign = ["left", "right"].includes(device.footerAlign) ? device.footerAlign : "";

    subTabContent.innerHTML = `

        <!-- ICON AND NAME -->
        <ha-expansion-panel outlined id="subPanel_header" header="${tx("header_title")}">
            <div class="col inner">
                <div class="row">
                    <ha-icon-picker class="cell" label="${tx("icon_choice")}" id="device_icon" data-path="devices.${box}.icon"></ha-icon-picker>
                    <label class="vrm-field cell">
                        <span class="vrm-field-label">${tx("name_choice")}</span>
                        <input class="vrm-input" type="text" id="device_name" data-path="devices.${box}.name">
                    </label>
                </div>
            </div>
        </ha-expansion-panel>

        <!-- READINGS AND CONTROL -->
        <ha-expansion-panel outlined id="subPanel_entities" header="${tx("sensor_title")}">
            <div class="col inner">
                <ha-selector label="${tx("entity_choice")}" id="device_sensor" data-path="devices.${box}.entity"></ha-selector>
                <ha-selector label="${tx("entity2_choice")}" id="device_sensor2" data-path="devices.${box}.entity2"></ha-selector>
                <ha-selector label="${tx("control_entity")}" id="device_control" data-path="devices.${box}.control_entity"></ha-selector>

                <!-- GRAPH AND GAUGE -->
                <div class="row">
                    <div class="row cell">
                        ${tx("enable_graph")} :
                        <ha-switch class="cell right" id="graph_switch" data-path="devices.${box}.graph"></ha-switch>
                    </div>
                    <div id="gauge_div" class="row cell">
                        ${tx("enable_gauge")} :
                        <ha-switch class="cell right" id="gauge_switch" data-path="devices.${box}.gauge"></ha-switch>
                    </div>
                </div>
            </div>
        </ha-expansion-panel>

        <!-- HEADER AND FOOTER -->
        <ha-expansion-panel outlined id="subPanel_entities2" header="${tx("header_footer_title")}">
            <div class="col inner">
                <div class="row">
                    <ha-selector label="${tx("entity_header")}" id="header_sensor" data-path="devices.${box}.headerEntity"></ha-selector>
                    <ha-selector label="${tx("entity_footer")}" id="footer1_sensor" data-path="devices.${box}.footerEntity1"></ha-selector>
                </div>
                <div class="row">
                    <ha-selector label="${tx("entity2_footer")}" id="footer2_sensor" data-path="devices.${box}.footerEntity2"></ha-selector>
                    <ha-selector label="${tx("entity3_footer")}" id="footer3_sensor" data-path="devices.${box}.footerEntity3"></ha-selector>
                </div>
                <div class="row">
                    <label class="vrm-field cell">
                        <span class="vrm-field-label">${tx("footer_layout")}</span>
                        <select class="vrm-input" id="footer_layout" data-path="devices.${box}.footerLayout">
                            <option value="">${tx("layout_horizontal")}</option>
                            <option value="vertical"${device.footerLayout === "vertical" ? " selected" : ""}>${tx("layout_vertical")}</option>
                        </select>
                    </label>
                    <label class="vrm-field cell">
                        <span class="vrm-field-label">${tx("footer_align")}</span>
                        <select class="vrm-input" id="footer_align" data-path="devices.${box}.footerAlign">
                            <option value="left"${footerAlign === "left" ? " selected" : ""}>${tx("align_left")}</option>
                            <option value=""${footerAlign === "" ? " selected" : ""}>${tx("align_center")}</option>
                            <option value="right"${footerAlign === "right" ? " selected" : ""}>${tx("align_right")}</option>
                        </select>
                    </label>
                </div>
            </div>
        </ha-expansion-panel>

        <!-- ANCHORS -->
        <ha-expansion-panel outlined id="subPanel_anchors" header="${tx("anchor_title")}">
            <div class="col inner">
                <div class="row">
                    <div class="col cell">
                        ${anchorLabel("left_qtyBox")}
                        ${anchorInput("anchor_left", perSide.L)}
                    </div>
                    <div class="col cell">
                        ${anchorLabel("top_qtyBox")}
                        ${anchorInput("anchor_top", perSide.T)}
                        ${anchorLabel("bottom_qtyBox", "margin-top:6px;")}
                        ${anchorInput("anchor_bottom", perSide.B)}
                    </div>
                    <div class="col cell">
                        ${anchorLabel("right_qtyBox")}
                        ${anchorInput("anchor_right", perSide.R)}
                    </div>
                </div>
            </div>
        </ha-expansion-panel>

        <!-- LINKS -->
        <div class="contMenu">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div class="headerMenu">${tx("add_links")}</div>
                <ha-icon-button id="add-link-button" aria-label="${tx("add_link")}">
                    <ha-icon icon="mdi:plus" style="display: flex;"></ha-icon>
                </ha-icon-button>
            </div>
            <div id="link-container" class="col noGap"></div>
        </div>
    `;

    // restore expanded panels of this editor
    if (!appendTo._expandedPanels) appendTo._expandedPanels = new Set(DEFAULT_EXPANDED_PANELS);
    appendTo._expandedPanels.forEach((id) => {
        subTabContent.querySelector(`ha-expansion-panel#${id}`)?.setAttribute("expanded", "");
    });
    subTabContent.querySelectorAll("ha-expansion-panel").forEach((panel) => {
        panel.addEventListener("expanded-changed", (event) => {
            if (event.detail.expanded) appendTo._expandedPanels.add(panel.id);
            else appendTo._expandedPanels.delete(panel.id);
        });
    });

    subTabContent.querySelector("#device_name").value = device.name ?? "";

    const iconPicker = subTabContent.querySelector("#device_icon");
    iconPicker.value = device.icon ?? "";
    iconPicker.hass = hass;

    setupEntitySelector(subTabContent.querySelector("#device_sensor"), device.entity, hass);
    setupEntitySelector(subTabContent.querySelector("#device_sensor2"), device.entity2, hass);
    setupEntitySelector(subTabContent.querySelector("#device_control"), device.control_entity, hass);
    setupEntitySelector(subTabContent.querySelector("#header_sensor"), device.headerEntity, hass);
    setupEntitySelector(subTabContent.querySelector("#footer1_sensor"), device.footerEntity1, hass);
    setupEntitySelector(subTabContent.querySelector("#footer2_sensor"), device.footerEntity2, hass);
    setupEntitySelector(subTabContent.querySelector("#footer3_sensor"), device.footerEntity3, hass);

    setSwitchChecked(subTabContent.querySelector("#graph_switch"), isTrue(device.graph));

    // The gauge fills the box with a 0–100 value. It can be switched on only
    // for a % entity, but an already enabled gauge (or an entity whose state is
    // not loaded yet) stays editable.
    const gaugeSwitch = subTabContent.querySelector("#gauge_switch");
    const unit = hass?.states?.[device.entity]?.attributes?.unit_of_measurement;
    const gaugeOn = isTrue(device.gauge);
    setSwitchChecked(gaugeSwitch, gaugeOn);
    if (!gaugeOn && hass?.states?.[device.entity] && unit !== "%") {
        gaugeSwitch.setAttribute("disabled", "");
        gaugeSwitch.setAttribute("title", t("subtabRender", "warning_gauge"));
    }

    const linkContainer = subTabContent.querySelector("#link-container");
    const links = device.link && typeof device.link === "object" ? device.link : {};

    Object.keys(links).filter((key) => LINK_ID.test(key)).forEach((linkKey) => {
        addLink(linkKey, box, hass, thisAllAnchors, otherAllAnchors, appendTo);
    });

    subTabContent.querySelector("#add-link-button").addEventListener("click", () => {
        // next free index (deleting a link must not make a new one overwrite another)
        const existing = Object.keys(appendTo._config.devices?.[box]?.link || {})
            .concat(Array.from(linkContainer.querySelectorAll("[data-link-index]")).map((el) => el.dataset.linkIndex))
            .filter((k) => LINK_ID.test(k))
            .map((k) => parseInt(k, 10));
        const nextIndex = existing.length ? Math.max(...existing) + 1 : 1;
        addLink(String(nextIndex), box, hass, thisAllAnchors, otherAllAnchors, appendTo);
    });
}

/* Anchors of all other boxes as "<box>_<side>-<n>" */
export function getAllAnchorsExceptCurrent(config, currentBox) {
    const allAnchors = [];

    visibleBoxIds(config).forEach((boxKey) => {
        const device = config.devices[boxKey];
        if (boxKey === currentBox || !device?.anchors) return;
        parseAnchors(device.anchors).forEach(({ type, qty }) => {
            for (let i = 1; i <= qty; i++) allAnchors.push(`${boxKey}_${type}-${i}`);
        });
    });

    allAnchors.sort();
    return allAnchors;
}

/* One link panel; index is a decimal string */
export function addLink(index, box, hass, thisAllAnchors, otherAllAnchors, appendTo) {

    const subTabContent = appendTo.shadowRoot.querySelector("#subTab-content");
    const linkContainer = subTabContent.querySelector("#link-container");

    const panel = document.createElement("ha-expansion-panel");
    panel.setAttribute("outlined", "");
    panel.setAttribute("expanded", "");
    panel.setAttribute("style", "margin: 0px 0px 8px 0px");
    panel.dataset.linkIndex = index;

    const link = appendTo._config.devices?.[box]?.link?.[index] || {};
    const selStyle = "width:100%;padding:8px 4px;background:var(--card-background-color,#1c2536);color:var(--primary-text-color);border:1px solid var(--divider-color,#404040);border-radius:4px;cursor:pointer;";
    const options = (anchors, current) => anchors
        .map((a) => `<option value="${esc(a)}"${a === current ? " selected" : ""}>${esc(a)}</option>`)
        .join("");
    const tx = (key) => esc(t("addLink", key));
    const path = `devices.${box}.link.${index}`;

    panel.innerHTML = `
        <div slot="header" style="display: flex; justify-content: space-between; align-items: center;">
            <span>${tx("link_title")} ${esc(index)}</span>
            <ha-icon-button class="delete-link-button" aria-label="${tx("delete_link")}" title="${tx("delete_link")}">
                <ha-icon icon="mdi:trash-can" style="display: flex;"></ha-icon>
            </ha-icon-button>
        </div>
        <div class="inner">
            <div class="col">
                <div class="row">
                    <div class="col cell">
                        <div style="font-size:0.85em;margin-bottom:4px;color:var(--secondary-text-color);">${tx("start")}</div>
                        <select class="link-start" data-path="${path}.start" style="${selStyle}">
                            <option value="">--</option>
                            ${options(thisAllAnchors, link.start)}
                        </select>
                    </div>
                    <div class="col cell">
                        <div style="font-size:0.85em;margin-bottom:4px;color:var(--secondary-text-color);">${tx("end")}</div>
                        <select class="link-end" data-path="${path}.end" style="${selStyle}">
                            <option value="">--</option>
                            ${options(otherAllAnchors, link.end)}
                        </select>
                    </div>
                </div>

                <div class="row">
                    <ha-selector class="cell link-entity" label="${tx("entity_picker")}" data-path="${path}.entity"></ha-selector>
                    <div class="row cell">
                        ${tx("reverse")} :
                        <ha-switch class="cell right link-inv" data-path="${path}.inv"></ha-switch>
                    </div>
                </div>
            </div>
        </div>
    `;

    panel.querySelector(".delete-link-button").addEventListener("click", (ev) => {
        ev.stopPropagation(); // do not toggle the panel
        appendTo._config = updateConfigRecursively(appendTo._config, path, null, true);
        notifyConfigChange(appendTo);
        panel.remove();
    });

    linkContainer.appendChild(panel);

    setupEntitySelector(panel.querySelector(".link-entity"), link.entity, hass);
    setSwitchChecked(panel.querySelector(".link-inv"), isTrue(link.inv));

    attachInputs(appendTo);
}

/************************************************/
/* Input listeners → config updates             */
/************************************************/
function listen(el, type, handler) {
    if (eventHandlers.has(el)) return;
    el.addEventListener(type, handler);
    eventHandlers.set(el, handler);
}

function commit(appendTo, key, value, rerender = false) {
    if (!key) return;
    appendTo._config = updateConfigRecursively(appendTo._config, key, value, true);
    notifyConfigChange(appendTo, rerender);
}

export function attachInputs(appendTo) {

    const root = appendTo.shadowRoot;

    // <select>: footer layout/alignment, link start/end
    root.querySelectorAll("select[data-path]").forEach((selectEl) => {
        listen(selectEl, "change", (e) => commit(appendTo, selectEl.dataset.path, e.target.value || null));
    });

    // text and number fields (font sizes, boxes per column, name)
    root.querySelectorAll("input.vrm-input").forEach((textField) => {
        listen(textField, "change", (e) => {
            let value = e.target.value;
            if (e.target.type === "number") {
                const n = parseInt(value, 10);
                value = isNaN(n) ? null : n; // empty → key removed
            } else {
                value = value.trim() || null;
                if (textField.dataset.path?.startsWith("styles.") && /^\d+(\.\d+)?$/.test(value ?? "")) value = Number(value);
            }
            commit(appendTo, textField.dataset.path, value);
        });
    });

    // anchor counts per side → "L-1, T-2, …"
    root.querySelectorAll("input.anchor").forEach((inputEl) => {
        listen(inputEl, "change", () => {
            const sides = [["L", "#anchor_left"], ["T", "#anchor_top"], ["B", "#anchor_bottom"], ["R", "#anchor_right"]];
            const anchors = [];
            sides.forEach(([side, selector]) => {
                const field = root.querySelector(selector);
                const qty = clampInt(field?.value ?? 0, 0, MAX_ANCHORS_PER_SIDE);
                if (field) field.value = String(qty);
                if (qty > 0) anchors.push(`${side}-${qty}`);
            });
            // link choices depend on the anchors → full re-render
            commit(appendTo, inputEl.dataset.path, anchors.length ? anchors.join(", ") : null, true);
        });
    });

    // ha-switch: plain booleans, or the "auto" switch of a font-size group
    root.querySelectorAll("ha-switch").forEach((toggle) => {
        listen(toggle, "change", (e) => {
            const isOn = typeof toggle.checked === "boolean" ? toggle.checked : !!e.target.checked;
            const group = toggle.dataset.group;

            if (!group) {
                commit(appendTo, toggle.dataset.path, isOn ? true : null);
                return;
            }

            const textField = root.querySelector(`input.vrm-input[data-group="${group}"]`);
            if (!textField) return;
            textField.disabled = isOn;
            const raw = textField.value.trim();
            const size = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw || null;
            commit(appendTo, textField.dataset.path, isOn ? "auto" : size);
        });
    });

    // theme radios
    root.querySelectorAll('input[type="radio"][data-path]').forEach((radio) => {
        listen(radio, "change", (e) => commit(appendTo, radio.dataset.path, e.target.value));
    });

    // Icon picker. The picker is controlled through .value: write the new
    // value back, otherwise the next hass refresh renders the stale one.
    root.querySelectorAll("ha-icon-picker").forEach((iconPicker) => {
        listen(iconPicker, "value-changed", (e) => {
            const value = e.detail?.value || null;
            iconPicker.value = value ?? "";
            commit(appendTo, iconPicker.dataset.path, value);
        });
    });

    // colour pickers ("change", not "input": saving on every drag closes the picker)
    root.querySelectorAll('input[type="color"]').forEach((colorInput) => {
        listen(colorInput, "change", (e) => commit(appendTo, colorInput.dataset.path, e.target.value));
    });

    // ball size slider
    root.querySelectorAll('input[type="range"]').forEach((rangeInput) => {
        listen(rangeInput, "change", (e) => commit(appendTo, rangeInput.dataset.path, ballSize({ ballSize: e.target.value })));
    });

    // Entity selectors (readings, control, header/footer, link signals).
    // Clearing removes the key; it is never replaced by a default. Like the
    // icon picker, the selector's .value is written back for hass refreshes.
    root.querySelectorAll("ha-selector[data-path]").forEach((entityPicker) => {
        listen(entityPicker, "value-changed", (e) => {
            const key = entityPicker.dataset.path;
            const raw = e.detail?.value;
            const value = typeof raw === "string" && raw.trim() ? raw.trim() : null;
            entityPicker.value = value ?? "";
            // the main entity decides whether the gauge switch is available
            commit(appendTo, key, value, /\.entity$/.test(key) && !/\.link\./.test(key));
        });
    });
}

/**********************************************/
/* Immutable config update                    */
/**********************************************/
export function updateConfigRecursively(obj, path, value, removeIfNull = false) {
    const keys = path.split(".");
    const clonedObj = structuredClone(obj);
    let current = clonedObj;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];

        if (i === keys.length - 1) {
            if (value === null && removeIfNull) delete current[key];
            else current[key] = value;
            break;
        }

        if (!current[key] || typeof current[key] !== "object") current[key] = {};
        current = current[key];
    }

    // Drop empty objects bottom-up. Top-level `devices` stays even when empty:
    // without it the card would fall back to the default boxes.
    const removeEmptyKeys = (o, depth) => {
        for (const key of Object.keys(o)) {
            if (!o[key] || typeof o[key] !== "object") continue;
            removeEmptyKeys(o[key], depth + 1);
            if (Object.keys(o[key]).length === 0 && !(depth === 0 && key === "devices")) delete o[key];
        }
    };

    removeEmptyKeys(clonedObj, 0);
    return clonedObj;
}

/***********************************/
/* Emit config-changed             */
/***********************************/
export function notifyConfigChange(appendTo, rerender = false) {
    // Remember what we sent so setConfig() can skip re-rendering our own echo
    // (focus, open panels). rerender=true forces the re-render, e.g. when the
    // anchors or the main entity change and dependent fields must update.
    try {
        appendTo._lastEmittedConfig = rerender ? null : JSON.stringify(appendTo._config);
    } catch (e) {
        appendTo._lastEmittedConfig = null;
    }
    appendTo.dispatchEvent(new CustomEvent("config-changed", {
        bubbles: true,
        composed: true,
        detail: { config: appendTo._config },
    }));
}

/********************************/
/* Main tabs                    */
/********************************/
export function attachLinkClick(renderTabContent, appendTo) {
    appendTo.shadowRoot.querySelectorAll("#tab-group .vrm-tab").forEach((link) => {
        listen(link, "click", (e) => {
            const tab = parseInt(e.currentTarget.getAttribute("data-tab"), 10);
            appendTo._currentTab = tab;
            appendTo._currentSubTab = 0;
            setActiveTab("#tab-group .vrm-tab", tab, appendTo);
            renderTabContent();
        });
    });
}

/********************************/
/* Box sub-tabs                 */
/********************************/
export function attachSubLinkClick(appendTo) {
    appendTo.shadowRoot.querySelectorAll("#subTab-group .vrm-tab").forEach((sublink) => {
        listen(sublink, "click", (e) => {
            const tab = parseInt(e.currentTarget.getAttribute("data-tab"), 10);
            appendTo._currentSubTab = tab;
            setActiveTab("#subTab-group .vrm-tab", tab, appendTo);
            renderSubTabContent(appendTo._currentTab, appendTo);
        });
    });
}
