# Home Assistant: Yasno startup retries

`yasno-setup-retry.patch` targets Yasno **v3.1.5**, upstream commit
`fd03a3bc575d9d36b8e98d160db186545356b752`.

Transient DNS, connection and request-timeout failures during setup now use
Home Assistant's native `ConfigEntryNotReady` handling: retry after roughly five
seconds, exponentially back off to ten minutes, and keep retrying until setup
succeeds. Permanent configuration errors and stale-address repairs are unchanged.

## Apply and deploy

Apply the patch to the upstream v3.1.5 source with `git apply`. Copy only the two
changed files, `__init__.py` and `api/base.py`, into
`/config/custom_components/yasno_outages/`, preserving originals first.
Run `ha core check`, then `ha core restart`. Reloading the integration alone
does not replace already-imported Python code.

Verify the `yasno_outages` config entry is `loaded` and its sensors report live
provider data. `emergency_shutdowns` with unknown restoration time is valid data,
not an unavailable integration. Do not trigger an announcement as a check.

Original files are kept on HA under
`/config/.local-overrides/yasno-startup-retry/original-v3.1.5/` for rollback.
The patch survives reboots. HACS automatic updates are disabled for this
integration; check whether a future release includes the fix before upgrading,
as an upgrade replaces the local files.

Native retry contract:
https://developers.home-assistant.io/docs/integration_setup_failures/
