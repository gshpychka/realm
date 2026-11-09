# Victron GX

The Cerbo runs the charging ramp locally in Node-RED. Grid restoration starts a 30-minute increase of the DVCC user ceiling from zero to the inverter's 140 A rating. The completed ramp restores the unrestricted user ceiling; inverter and battery-management limits remain active.

`flow.nix` declares the flow and Home Assistant controls. `charging-ramp.js` owns ramp and override behavior. `deploy.py` applies these declarations through the native APIs, preserving unrelated flows and dashboard views.

## Operation

- **Victron → Charging → Full charging now** restores normal charging until the next grid outage. The Node-RED inject button and `deploy.py full` perform the same override.
- An outage arms a fresh ramp. A Node-RED restart with grid present starts a fresh ramp.
- The Home Assistant override also releases the ceiling while Node-RED is stopped. A stopped Node-RED retains its last DVCC setting until it is released or the controller resumes.
- DVCC applies this ceiling to its managed chargers, including solar chargers. Generator and shore input retain normal charging.

## Deployment

Supply the GX local-network password in `VICTRON_PASSWORD` and the existing Home Assistant API token in `HOME_ASSISTANT_TOKEN`. The executable uses a Nix-provided Python with `websocket-client`.

```sh
scripts/victron/deploy.py deploy
scripts/victron/deploy.py status
scripts/victron/deploy.py full
```

HTTPS uses the GX certificate pin in `flow.nix`. Credentials stay outside the repository. Tokens remain in process memory and are revoked after each command.

Deployment prints a private snapshot path under `~/.local/state/victron-node-red/`. Rollback releases the charging ceiling and restores the snapshot's owned flow, script and dashboard view:

```sh
scripts/victron/deploy.py rollback --backup /path/to/snapshot.json
```

Native API contract: <https://nodered.org/docs/api/admin/methods/post/flows/>.
