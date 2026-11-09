# Victron GX

The Cerbo runs the charging ramp locally in Node-RED. Grid restoration increases the DVCC user ceiling from zero to the inverter's current limit over the configured duration. The completed ramp restores the unrestricted user ceiling; inverter and battery-management limits remain active.

`flow.nix` declares the flow and single-page Victron dashboard; `rampDurationMinutes` sets the duration. `charging-ramp.js` owns ramp and override behavior. `deploy.py` applies these declarations through the native APIs, preserving unrelated flows and dashboards. Deployment enables the existing Home Assistant charging-current entity; rollback restores its original enabled state.

## Operation

- **Victron → Full charging now** skips the remaining charging ramp. The override ends at 100% battery SOC or the end of the original ramp window, whichever comes first; normal charging continues. The Node-RED inject button and `deploy.py full` perform the same override.
- The Victron page shows the current charging ceiling, controller status, elapsed ramp time and remaining time. Timing updates every ten seconds through Home Assistant's existing MQTT broker; readings expire after 45 seconds without telemetry. Charging decisions run locally on the Cerbo.
- An outage arms a fresh ramp. A Node-RED restart with grid present starts a fresh ramp.
- Flow redeployments preserve in-memory ramp progress and overrides.
- Flow memory holds charging state; node memory holds the running timer.
- The Home Assistant override also releases the ceiling while Node-RED is stopped. A stopped Node-RED retains its last DVCC setting until it is released or the controller resumes.
- DVCC applies this ceiling to its managed chargers, including solar chargers. Generator and shore input retain normal charging.

## Deployment

Supply the GX local-network password in `VICTRON_PASSWORD` and the existing Home Assistant API token in `HOME_ASSISTANT_TOKEN`. The executable uses a Nix-provided Python with `websocket-client`.

Deployment also requires the existing Home Assistant broker credentials in `MQTT_USERNAME` and `MQTT_PASSWORD`. Node-RED owns the broker credential store.

```sh
scripts/victron/deploy.py deploy
scripts/victron/deploy.py status
scripts/victron/deploy.py full
```

HTTPS uses the GX certificate pin in `flow.nix`. Credentials stay outside the repository. Tokens remain in process memory and are revoked after each command.

Deployment prints a private snapshot path under `~/.local/state/victron-node-red/`. Rollback releases the charging ceiling and restores the snapshot's owned flow, script and Victron dashboard. Restoring a flow without telemetry removes its MQTT sensor definitions:

```sh
scripts/victron/deploy.py rollback --backup /path/to/snapshot.json
```

Restart Node-RED before deploying after a rollback.

Native API contract: <https://nodered.org/docs/api/admin/methods/post/flows/>.
