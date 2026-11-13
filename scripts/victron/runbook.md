# Victron GX

The Cerbo ramps total AC-input current locally in Node-RED. Grid restoration after at least `minimumOutageMinutes` without mains starts a linear ramp with one update per minute. Completion restores `normalInputCurrentA`; PowerAssist supplies the remaining household demand, and native inverter and battery-management limits remain active.

`flow.nix` declares the flow, `rampDefaults` and single-page Victron dashboard. `charging-ramp.js` owns the active window; `ramp-settings.js` saves configuration on the Cerbo at `settingsFile`. The chart's gear opens Ramp enabled, Skip once, next-ramp numbers and one Restore defaults button. Saved configuration survives Home Assistant and Node-RED restarts.

## Operation

- **Skip once** reconnects grid input at its normal current limit for the current window. Automatic operation remains enabled for the next grid return. The inject button and `deploy.py full` perform the same override. Full battery SOC leaves a whole-input window active because the allowance also supplies household loads.
- **Ramp enabled** persists its on/off state. Turning it off releases the current restriction; turning it on arms the next grid return. Numeric settings apply to the next window. **Restore defaults** applies the declared numbers and preserves the on/off choice.
- **Throttle** resumes an open window or starts a new configured window. It requires ready grid and battery inputs. `deploy.py throttle` performs the same action.
- The ramp card sits below the main Victron overview. Its corner handle resizes width and graph height by pointer, touch or arrow keys; dimensions and history range stay in that browser. The card shows input limit, remaining time, effective ramp duration, charge deadline and next outage. A deadline-ended ramp carries its reason.
- The chart pairs battery SoC with a smaller Grid/Limit plot on one timeline. Solid SoC records history; dashed SoC follows the local energy forecast through the next outage. Charge by, next outage and estimated full-charge time identify the charging window. A missed deadline shows the projected shortfall.
- Cycle frames the relevant outage and charging period; fixed history ranges remain available. Clicking pins a selectable inspector across both plots. Historical readings open native history; future readings identify estimates. The heading is read-only; Skip once remains an explicit action in Ramp settings.
- The future Limit is planned input allowance. Actual grid consumption and battery charging remain distinct. Native current quantization and the PowerAssist minimum remain hardware-owned.
- Recorder history belongs to Home Assistant. Live timing arrives through its MQTT broker and expires after 45 seconds without telemetry. Charging decisions run locally on the Cerbo.
- Automatic ramps require a continuous outage of at least `minimumOutageMinutes`. Shorter outages restore normal input. Manual Throttle starts remain available. An already-present grid starts in normal operation when Node-RED starts.
- The saved duration is the maximum ramp length. The local forecast uses system SoC, BMS installed Ah, optional reported health and measured battery voltage. `assumedChargingPowerW` supplies unobserved charging bands; it never sets a native charging limit.
- Consumption is grid input minus battery charging power, including conversion losses. A learned hourly UTC profile supplies future demand; a recent EWMA correction decays over `consumptionWindowMinutes`. During an outage, grid import is zero. The forecast includes charging and discharge throughout the ramp and subsequent normal input.
- Every minute, the controller chooses the longest remaining ramp under `forecastTargetProbability`, using the learned residual decision model when enough observations exist. `outageMarginMinutes` is the single fixed deadline margin. Active duration and deadline only move earlier. An impossible decision-model deadline releases the ramp and leaves the expected curve and decision shortfall distinct. The probability is a policy target, not a measured guarantee.
- Home Assistant publishes the earliest future planned or probable outage from its full calendars and next-outage sensors, alongside scheduled grid restoration, every minute and on schedule, startup and broker-connection changes. The Cerbo caches them and owns the deadline locally. An earlier schedule tightens an active deadline; a later or missing schedule never extends it. Without a known next outage, the saved maximum duration applies. An outage forecast requires a known future restoration time.
- Flow redeployments preserve in-memory ramp progress and overrides.
- An open ramp window keeps its elapsed time and deadline through unavailable forecast inputs. Normal input supplies the loads while readings recover; a valid snapshot resumes the remaining ramp automatically. Grid-availability changes request an immediate native snapshot alongside the minute cadence.
- Flow memory holds the active window; node memory holds its timer and pending current write.
- A zero allowance isolates AC input. A positive allowance reconnects after its native current-write completion. Physical mains availability is independent of input isolation. A disabled BMS discharge allowance releases the restriction.
- The Home Assistant restore script also restores input current and connection while Node-RED is stopped. A stopped controller retains its last hardware settings.

## Adaptive forecast

`charging-learning.js` keeps independent consumption, unrestricted charging and charge/discharge effective-capacity statistics. Each observation's signed prediction error updates an EWMA bias and absolute-error scale. Their ratio chooses a bounded update rate: consumption 1–15%, charging 1–12%, capacity 0.5–3%. Persistent bias speeds adaptation; alternating noise slows it. A recent consumption EWMA follows measured demand with the declared time constant. Unobserved hours use recent demand; unobserved charging bands use `assumedChargingPowerW`.

Learning samples once per minute. Consumption is bounded to twice normal input power. Charging uses ten 10%-SoC bands and consecutive observations below 99% SoC with positive current above 2 A and power above 100 W. The input must be connected, unrestricted by an active ramp, at its normal current limit, with more than 1 A grid headroom and more than 2 A BMS charging headroom. Battery power must agree with native BMS current times voltage within 10% or 200 W. Idle, full, discharging, binding grid and BMS-limited observations leave the charging learner unchanged.

Installed Ah times optional health supplies the initial effective capacity. Native BMS current is trapezoid-integrated over continuous, same-direction segments spanning at least 15 SoC points and 15 minutes. Charge and discharge estimates remain separate; the forecast uses the relevant estimate for each direction. Accepted estimates are 50–150% of reported baseline, end between 5% and 95% SoC and span at most 12 hours. Missing/stale measurements, sample gaps over 90 seconds, current reversals, source mismatches and implausible SoC jumps discard the segment. A reported baseline change over 2% resets capacity calibration, completed residual histories and pending cohorts. These values estimate Ah per reported SoC range; they do not measure physical battery health or modify BMS settings.

Expected forecast points stay free of risk offsets. A saved, nonoverlapping 30-minute SoC prediction supplies a signed deficit in equivalent watts; a completion cohort supplies a signed completion-time residual in the same units. SoC checkpoints require at least two points of predicted movement. Completion cohorts start at or below 90% SoC with expected completion over 15 minutes and at most six hours away. An uncompleted 12-hour cohort contributes its observed lateness lower bound. Policy, schedule, input-mode and ramp-duration changes invalidate pending cohorts; data gaps and SoC resets also discard them. Predictions are captured before the observations they score. Each residual history retains at most 128 values.

The decision model warms up until both histories contain 20 observations. Warm-up uses the component estimates and fixed charging assumptions without a probability claim. After warm-up, one equivalent-power offset is the greater of the two one-sided residual quantiles at `forecastTargetProbability`, floored at zero. This single offset changes ramp selection, with no extra time padding or per-input margins. Forecast `decision` telemetry carries its risk-mode, offset, full time and deadline SoC; `learning` carries sample counts, component means, bias, update rates, source readiness and persistence errors. `probability_calibrated` remains false: these empirical, mixed-horizon histories do not establish achieved completion coverage, and changing conditions can still miss the deadline.

The selected system `/ActiveBatteryService` must exactly match `battery.service`, `/Connected` must be 1, and system `/Dc/Battery/Soc` must agree with native BMS `/Soc` within one point. Forecast decisions require a successful local acquisition within three minutes, valid capacity, voltage and battery/grid power, physical availability consistent with immediate control inputs, positive BMS discharge allowance and ready controller inputs. Native BMS current and grid/charging headroom gate calibration only; missing current leaves the assumption-backed forecast available.

An owned exec node runs installed `/usr/bin/python3` with `dbus` every minute. It reads root `GetItems` directly from the local system bus for system, selected battery instance and VE.Bus instance, then emits one timestamped snapshot. `/ActiveBmsService` and `/VebusService` prioritize actual service names; `/DeviceInstance` verifies the declared instances. Discovery considers at most 16 candidates per service type. `GetValue` has a two-second timeout, `GetItems` three seconds, and exec bounds the whole acquisition to 15 seconds. Empty DBus arrays become null. Failed acquisitions invalidate the snapshot; unchanged successful reads remain valid observations, each scored once at its acquisition time. Native input callbacks retain immediate protection/control duties and never establish acquisition freshness. The global Victron client and its polling configuration stay untouched.

All forecast and decision simulations stop within 48 hours, with a fixed minute-step/transition budget and at most 1,440 duration candidates. Remote outage/deadline times impose an earlier conservative 48-hour decision boundary; telemetry retains the reported schedule, marks `schedule_capped`, and exposes `decision.evaluated_deadline_at`. A remote restoration never brings power forward. Truncated projections make no claim about SoC at a deadline beyond the horizon. Active ramp duration still only shortens.

Before policy deployment, exercise the exact evaluated `victron-charging-ramp-acquire-exec` command through a temporary read-only native exec node. Verify root `GetItems` decoding, declared instance resolution, selected source identity, all decision fields and the acquisition timestamp; verify timeout/error exit propagation and remove the temporary probe. Installed Python, `dbus.SystemBus`, root `GetItems` on all three services and this installation's actual service names require live confirmation. A responsive service proves a direct acquisition, not freshness of its underlying CAN frames; the exposed connection flag remains the BMS-side health signal.

Only versioned model statistics are saved at `learningFile`, by atomic replacement after the first learned consumption sample and at most once per 15 minutes thereafter, with exact readback. Missing or invalid files start from assumptions; persistence failures remain visible and retry after the write interval. The last 15 minutes of learning can be lost on a restart. Ramp state, timers, pending predictions, recent-demand correction and integration segments remain in memory. The settings file and saved operating duration remain independent. Home Assistant supplies only the outage schedule to local charging policy.

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

These actions own the dashboard frontend, its scripts and resources. Charging policy, device registry and GX runtime remain unchanged. Refresh the HA page after deploying a frontend resource. The copied frontend's Apache-2.0 license and upstream attribution are embedded in `dashboard/victron-energy-card.js`; the logo's source attribution is embedded in its SVG.

## Deployment

Supply the GX local-network password in `VICTRON_PASSWORD` and the existing Home Assistant API token in `HOME_ASSISTANT_TOKEN`. The executable uses a Nix-provided Python with `websocket-client`.

Initial telemetry setup also requires the existing Home Assistant broker credentials in `MQTT_USERNAME` and `MQTT_PASSWORD`. Node-RED owns the broker credential store; subsequent deployments reuse it.

Install Mushroom and Layout Card through HACS. Mushroom owns the ramp heading and feature composition; Layout Card places its resizable wrapper below the power-flow view.

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

## SSH

`ssh cerbo` logs in as root with the keys in `my.hosts.cerbo.authorizedKeys` from `modules/common/hosts.nix`. Root's keys live on `/data` and survive firmware updates; a firmware update resets the root password.

Bootstrap follows <https://www.victronenergy.com/live/ccgx:root_access>: Superuser access level, a root password and SSH on LAN. This command writes the declared keys and locks password login; the first run authenticates with the root password:

```sh
nix eval --raw .#nixosConfigurations.reaper.config.my.hosts.cerbo.authorizedKeys --apply 'ks: builtins.concatStringsSep "\n" ks + "\n"' |
  ssh cerbo 'mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys && echo "root:*" | chpasswd -e'
```
