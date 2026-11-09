# victron-energy-card

Venus OS GUI v2 style power-flow card for Home Assistant. A modified copy of the card from [hass-victron-vrm-api](https://github.com/jayjojayson/hass-victron-vrm-api) (Apache-2.0); see `NOTICE` and `LICENSE`.

The card displays any Home Assistant entity from any integration. It reads `hass.states` and the recorder history endpoint. It never calls services. Tapping a box opens Home Assistant's more-info dialog.

Compact containers use a taller layout and readable minimum auto font sizes. Explicit font sizes retain their configured values.

## Files

`victron-energy-card.js` is the module entry point. It registers `custom:victron-energy-card` and its visual editor, `victron-energy-card-editor`. It imports the other nine modules relative to its own URL, so all ten files must be served from one directory: `lib-venus.js`, `editor.js`, `lib-editor.js`, `css-dark.js`, `css-light.js`, `css-editor.js` and `lang-{en,de,fr}.js`. The card loads no external assets.

## Configuration

`type: custom:victron-energy-card` with no other keys gives the default layout. The same configuration is returned by the card picker's stub. The default layout has four boxes: Grid and Battery in column 1, MultiPlus in column 2, Loads in column 3. It uses the Cerbo GX MQTT entities and has no solar box. If `devices` is present, even as `{}`, it is used exactly as written and no default box is added.

| Option | Values | Meaning |
| :--- | :--- | :--- |
| `theme` | `auto` (default), `light`, `dark`, `transparent` | `auto` follows the HA dark mode |
| `param.boxCol1` / `boxCol2` / `boxCol3` | 1–4 / 1–2 / 1–4 (default 1) | Boxes per column |
| `param.ballSize` | number, 0.5–20 (default 4) | Flow ball radius at a card width of 1000 px |
| `styles.header` / `sensor` / `sensor2` / `footer` | px number, `<n>px/em/rem/%`, or `auto` | Font sizes; `auto` scales with the box width |
| `colors.boxShadow` / `anchor` / `graph` / `history` / `ball` / `textMain` / `textSub` | hex, colour keyword, `rgb()`/`hsl()`, `var(--x)` | Colour overrides; other values are ignored |
| `devices."<col>-<box>"` | `1-1` … `3-4` | One box; boxes beyond the column count are ignored |

### Box (`devices."c-b"`)

| Key | Meaning |
| :--- | :--- |
| `name`, `icon` | Title and `mdi:` icon |
| `entity` | Main reading. Its more-info opens on tap unless `control_entity` is set |
| `entity2` | Secondary reading |
| `headerEntity` | Value next to the title |
| `footerEntity1`–`footerEntity3` | Footer values; `footerLayout: vertical`, `footerAlign: left/right` |
| `control_entity` | Entity whose more-info opens on tap, e.g. a `number` or `select` that controls the device. Choosing a reading never changes the device |
| `graph: true` | 24-hour sparkline of `entity` from recorder history, refreshed every 15 minutes |
| `gauge: true` | Fills the box with `entity` as a percentage, clamped to 0–100 |
| `anchors` | Connection points per side, e.g. `L-1, B-2, R-1` (**L**eft, **T**op, **B**ottom, **R**ight, 1–3 each) |
| `link."<n>"` | `start` is an anchor of this box (`R-1`); `end` is an anchor of another box (`2-1_L-1`); `entity` is the flow signal; `inv: true` reverses the flow |

Missing, `unknown` and `unavailable` states show as `—`. They are never read as zero.

### Flow direction

A link's ball moves from `start` to `end` while its signal is positive and from `end` to `start` while it is negative. `inv: true` swaps the two directions. The flow stops and the ball is hidden in these cases:

- the signal is zero or within ±0.5;
- the signal is missing, `unknown`, `unavailable` or non-numeric;
- the link has no signal entity.

The defaults follow these sign conventions:

| Link | Signal | Positive means | Configuration |
| :--- | :--- | :--- | :--- |
| Grid `R-1` → `2-1_L-1` | `sensor.multiplus_input_power_l1` | import, grid → inverter | — |
| Battery `R-1` → `2-1_B-1` | `sensor.battery_dc_bus_current` | charging, inverter → battery | `inv: true` |
| Loads `L-1` → `2-1_R-1` | `sensor.cerbo_consumption_power_l1` | consumption, inverter → loads | `inv: true` |

The Battery box opens `number.cerbo_ess_max_charge_current` on tap. The MultiPlus box opens `select.multiplus`.
