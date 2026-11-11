# Victron GX

The Cerbo ramps total AC-input current locally in Node-RED. Grid restoration after at least `minimumOutageMinutes` without mains starts a linear ramp with one update per minute. Completion restores `normalInputCurrentA`; PowerAssist supplies the remaining household demand, and native inverter and battery-management limits remain active.

`flow.nix` declares the flow, `rampDefaults` and single-page Victron dashboard. `charging-ramp.js` owns the active window; `ramp-settings.js` saves configuration on the Cerbo at `settingsFile`. The chart's gear opens Ramp enabled, Skip once, next-ramp numbers and one Restore defaults button. Saved configuration survives Home Assistant and Node-RED restarts.

## Operation

- **Skip once** reconnects grid input at its normal current limit for the current window. Automatic operation remains enabled for the next grid return. The inject button and `deploy.py full` perform the same override. Full battery SOC leaves a whole-input window active because the allowance also supplies household loads.
- **Ramp enabled** persists its on/off state. Turning it off releases the current restriction; turning it on arms the next grid return. Numeric settings apply to the next window. **Restore defaults** applies the declared numbers and preserves the on/off choice.
- **Throttle** resumes an open window or starts a new configured window. It requires ready grid and battery inputs. `deploy.py throttle` performs the same action.
- Tap the Mushroom card or its icon to skip an active ramp. Chart interaction inspects history; clicking the chart pins a selectable inspector.
- The chart shows recorded Grid power and the active Limit, with a shared power scale and a shaded grid trace. Native current quantization and the PowerAssist minimum remain hardware-owned.
- Recorder history belongs to Home Assistant. Live timing arrives through its MQTT broker and expires after 45 seconds without telemetry. Charging decisions run locally on the Cerbo.
- Automatic ramps require a continuous outage of at least `minimumOutageMinutes`. Shorter outages restore normal input. Manual Throttle starts remain available. An already-present grid starts in normal operation when Node-RED starts.
- The saved duration is the maximum ramp length. Every minute, actual SOC determines a conservative estimate of full-charge time using `rechargeMinutesPerPercent` and `rechargeTailMinutes`. The remaining ramp counts as charging delay. Its length only decreases to reserve that budget before the next outage, with `outageMarginMinutes` to spare; an exhausted budget restores normal input immediately. The charging estimate is not a guarantee.
- Home Assistant publishes the earliest future planned or probable outage every minute and on schedule, startup and broker-connection changes. The Cerbo caches that timestamp and owns the deadline locally. An earlier schedule tightens an active deadline; a later or missing schedule never extends it. Without a known next outage, the saved maximum duration applies.
- Flow redeployments preserve in-memory ramp progress and overrides.
- Flow memory holds the active window; node memory holds its timer and pending current write.
- A zero allowance isolates AC input. A positive allowance reconnects after its native current-write completion. Physical mains availability is independent of input isolation. A disabled BMS discharge allowance releases the restriction.
- The Home Assistant restore script also restores input current and connection while Node-RED is stopped. A stopped controller retains its last hardware settings.

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

`charging-chart.js` is a chart feature registered as a content-addressed data URI. History and the native settings popup use the authenticated Home Assistant frontend connection. The native `victron_toggle_charging` script skips an active ramp. Existing entity and script identifiers retain their names.

```sh
scripts/victron/deploy.py deploy
scripts/victron/deploy.py status
scripts/victron/deploy.py full
scripts/victron/deploy.py throttle
```

HTTPS uses the GX certificate pin in `flow.nix`. Credentials stay outside the repository. Tokens remain in process memory and are revoked after each command.

Deploy policy and its controls together with `deploy`; use `frontend` for presentation-only updates after policy is deployed. Deployment prints a private snapshot path under `~/.local/state/victron-node-red/`. Rollback restores normal input and the captured owned flow, schedule publisher, scripts, frontend resource, registry flags and overview:

```sh
scripts/victron/deploy.py rollback --backup /path/to/snapshot.json
```

Restart Node-RED before deploying after a rollback.

Native API contract: <https://nodered.org/docs/api/admin/methods/post/flows/>.
