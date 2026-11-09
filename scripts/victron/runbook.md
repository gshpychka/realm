# Victron GX

The Cerbo runs the charging ramp locally in Node-RED. Grid restoration increases the DVCC user ceiling from zero to the inverter's current limit over the configured duration. The completed ramp restores the unrestricted user ceiling; inverter and battery-management limits remain active.

`flow.nix` declares the flow and single-page Victron dashboard; `rampDurationMinutes` sets the duration. `charging-ramp.js` owns ramp and override behavior. `deploy.py` applies these declarations through the native APIs, preserving unrelated flows and dashboards. Deployment enables the existing Home Assistant charging-current entity; rollback restores its original enabled state.

## Operation

- **Restore** skips the remaining charging ramp. The override ends at 100% battery SOC or the end of the original ramp window, whichever comes first; normal charging continues. The Node-RED inject button and `deploy.py full` perform the same override.
- **Throttle** applies the ramp at the current point in an open window, or starts a new configured window. It requires live grid inputs. `deploy.py throttle` performs the same action.
- Tap the Mushroom card or its icon for the displayed Restore/Throttle action. Chart interaction only inspects history; clicking the chart pins a selectable inspector.
- The charging card plots recorded BMS and user ceilings, actual battery current and SoC, with policy-coloured mode bands and transition timestamps. Its dashed future trace follows the remaining configured ramp. Unrestricted user ceilings remain nonnumeric; future BMS limits, actual current and SoC remain unmeasured.
- Recorder history belongs to Home Assistant. Live timing arrives through its MQTT broker and expires after 45 seconds without telemetry. Charging decisions run locally on the Cerbo.
- An outage arms a fresh ramp. A Node-RED restart with grid present starts a fresh ramp.
- Flow redeployments preserve in-memory ramp progress and overrides.
- Flow memory holds charging state; node memory holds the running timer.
- The Home Assistant override also releases the ceiling while Node-RED is stopped. A stopped Node-RED retains its last DVCC setting until it is released or the controller resumes.
- DVCC applies this ceiling to its managed chargers, including solar chargers. Generator and shore input retain normal charging.

## Energy card

`dashboard/` contains the standalone `custom:victron-energy-card` and its visual editor. The frontend reads Home Assistant entities and Recorder history. Its default layout uses the local MQTT entities for Grid, Battery, MultiPlus and House loads.

The visual editor configures each box's main and secondary entities, footer readings, graph, gauge, icon, name and connection anchors. `control_entity` selects the entity whose native Home Assistant dialog opens when the box is clicked; its value is independent of the displayed reading. A Battery box can display SoC and open the charging-current control.

```yaml
type: custom:victron-energy-card
```

An explicit `devices` map supplies the complete set of boxes and supports entities from any integration. Connection `entity` readings determine flow direction; `inv` sets the sign convention. Missing and unavailable readings stop their flow.

Frontend deployment requires the existing HA token and SSH access to HA's `/config/www`. `HOME_ASSISTANT_SSH_COMMAND` supplies the SSH executable, options and destination; its default is `ssh -o BatchMode=yes root@homeassistant.glib.sh`. Assets have content-addressed directories and verified checksums.

```sh
scripts/victron/deploy.py frontend
scripts/victron/deploy.py frontend-rollback --backup /path/to/frontend-snapshot.json
```

These actions own the dashboard frontend, its scripts and resources. Charging policy, device registry and GX runtime remain unchanged. Refresh the HA page after deploying a frontend resource. The copied frontend's Apache-2.0 license and upstream attribution live in `dashboard/LICENSE` and `dashboard/NOTICE`.

## Deployment

Supply the GX local-network password in `VICTRON_PASSWORD` and the existing Home Assistant API token in `HOME_ASSISTANT_TOKEN`. The executable uses a Nix-provided Python with `websocket-client`.

Initial telemetry setup also requires the existing Home Assistant broker credentials in `MQTT_USERNAME` and `MQTT_PASSWORD`. Node-RED owns the broker credential store; subsequent deployments reuse it.

Install Mushroom and Layout Card through HACS. Mushroom owns the card and its actions; Layout Card keeps the compact card above the full-width power-flow view.

`charging-chart.js` is a chart-only card feature registered as a content-addressed data URI. History uses the authenticated Home Assistant frontend connection. The native `victron_toggle_charging` script selects restore during an active ramp and throttles only with ready grid inputs.

```sh
scripts/victron/deploy.py deploy
scripts/victron/deploy.py status
scripts/victron/deploy.py full
scripts/victron/deploy.py throttle
```

HTTPS uses the GX certificate pin in `flow.nix`. Credentials stay outside the repository. Tokens remain in process memory and are revoked after each command.

Deployment prints a private snapshot path under `~/.local/state/victron-node-red/`. Rollback releases the charging ceiling and restores the snapshot's owned flow, scripts, frontend resource and Victron dashboard. Restoring a flow without telemetry removes its MQTT sensor definitions:

```sh
scripts/victron/deploy.py rollback --backup /path/to/snapshot.json
```

Restart Node-RED before deploying after a rollback.

Native API contract: <https://nodered.org/docs/api/admin/methods/post/flows/>.
