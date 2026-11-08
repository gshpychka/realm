# Yasno setup retries

Transient DNS, connection and request-timeout failures during setup use
[Home Assistant's native retry contract](https://developers.home-assistant.io/docs/integration_setup_failures/),
with exponential backoff from roughly five seconds to ten minutes.

`yasno-setup-retry.patch` targets Yasno v3.1.5, upstream commit
`fd03a3bc575d9d36b8e98d160db186545356b752`.

## Deploy

Preserve the integration files, then apply the patch to the upstream v3.1.5 source
with `git apply`. Copy `__init__.py` and `api/base.py` into
`/config/custom_components/yasno_outages/`.
Run `ha core check`, then `ha core restart` to load the updated Python modules.

## Verify

Use read-only integration and sensor queries. The `yasno_outages` config entry is
`loaded`, and its sensors report provider data. `emergency_shutdowns` permits
an unknown restoration time.

## Maintain

HACS uses manual updates for this integration. Review patch compatibility with
each integration upgrade.

Original files for rollback are in
`/config/.local-overrides/yasno-startup-retry/original-v3.1.5/` on HA.
