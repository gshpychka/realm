# Maintainerr notification compatibility patch

The existing host module deploys Maintainerr with Nix OCI containers. The locked
nixpkgs tree has no Maintainerr NixOS service module. Upstream 3.8.0 accepts
runtime environment variables for hosting (TZ, UI_PORT, UI_HOSTNAME, BASE_PATH,
DATA_DIR, etc.), not a complete declarative rules/notifications settings file.
Rules have native YAML encode/decode/import support, but that is not an
idempotent boot-time desired-state reconciler. Integrations, rules, collection
membership, exclusions and notification settings remain database-backed state.

References:
- https://github.com/Maintainerr/Maintainerr/blob/v3.8.0/README.md
- https://github.com/Maintainerr/Maintainerr/blob/v3.8.0/apps/server/src/modules/rules/rules.controller.ts
- https://github.com/Maintainerr/Maintainerr/blob/v3.8.0/apps/server/src/modules/notifications/notifications.controller.ts
- https://github.com/Maintainerr/Maintainerr/blob/v3.30.1/apps/server/src/modules/collections/collection-handler.ts

## Why a narrow patch

Native event selection cannot distinguish successful-cleanup membership removal
from a genuine cancellation. Disabling MEDIA_REMOVED_FROM_COLLECTION globally
would lose cancellation/rescue notices. Checking the maintained upstream source
also did not reveal a configurable cleanup-reason filter. A broad application
upgrade is deliberately outside this notification-only fix.

- Successful cleanup calls removeFromCollection with notifyRemoval=false.
- Manual edits and media-server sync removals/adds retain default true.
- Rule-owned sync (rule-executor.service.js handleCollection) had two emitters for
  one change: the collection service (identifier `collection`) and the executor's
  verified delta (identifier `rulegroup`). The notification dispatcher resolves
  both to the same rule group and notifiers, so every rule add and rule removal /
  viewing rescue was sent twice, identically. Upstream main source (checked
  2026-10-16, latest release v3.30.1) still has both emitters. The executor is now the single owner: it passes
  notifyAdded=false / notifyRemoval=false on all four add/remove entry points
  (resolved-link and ordinary), and reports each step's database-verified delta
  immediately after that step. So a removal failure or abort later in the same run
  cannot hide an add that already happened; partial changes list only verified
  items; an unreadable membership list reports nothing rather than guessing.
- MEDIA_HANDLED emission and all media/state operations are unchanged.
- Telegram gains optional messageThreadId, only used by a failure-only notifier
  routed to the existing Status topic. Ordinary messages keep their destination.
- The source image digest and four patched source hashes are pinned. On upgrade the
  compatibility patch fails closed and must be reviewed or removed if upstream
  has fixed the underlying issues. Source maps remain upstream maps, so patched
  line offsets can differ slightly in stack traces.

No proxy, notification framework, new scheduler, rule migration or DB rewriting.
The preStart hook extracts source from an **unstarted** image, validates hashes,
and mounts only four modules read-only.

## Small declarative settings boundary

maintainerr.nix declares the owned failure notifier name, event types32/64 and
existing status topic22. Its postStart hook calls the native API to create/update
only that named record and bind it to currently active rule groups. Existing
ordinary notifier, all rules/collections/history and unrelated settings survive.
API success and config/binding readback are checked; repeated runs converge.
Newly created/reactivated rule groups require running reconciliation again (or a
normal service restart); this small hook does not continuously manage rule state.

Credentials are reused at runtime from existing private Maintainerr state. None
are embedded in the Nix store, source or logs. If more settings are later managed,
use explicit non-secret desired JSON and SOPS runtime secret files, native API
upserts keyed by stable ID/name, and preservation of unmanaged resources. Do not
install a seed/replace SQLite database: it would destroy operational state.
A question about declarative configuration does not authorize migrating all rules.

## Rollback / deployment

Because this host has a read-only NixOS /etc unit tree, activation uses a native
**runtime-only systemd override generated from the evaluated Nix unit**, restarting
only Maintainerr. No whole-host switch and no Gateway restart. The declarative
source belongs to the canonical realm checkout; apply it in the next ordinary
NixOS switch for reboot persistence. Until then the live override disappears on
reboot. The generated unit has an explicit local Nix GC root until that switch.
Remove the named runtime drop-in after the ordinary switch to avoid overriding
future unit generations; never use systemctl revert (it may remove other edits).

Protected beforeimages and exact deployed unit identifiers are recorded in the
private operational repair report, not in the public repo. To roll back before
the full switch, remove only the named runtime drop-in, reload systemd and restart
only Maintainerr, then remove only the owned failure notifier via its native
DELETE API. Restore the Radarr notifier name via
its saved notification API object if desired. Do **not** restore the whole DB to
undo a notification change: newer history and media state must be preserved.
