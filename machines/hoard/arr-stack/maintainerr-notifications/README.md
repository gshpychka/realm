# Maintainerr notification compatibility patch

The host module deploys Maintainerr with Nix OCI containers. The locked
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
would lose cancellation/rescue notices. The pinned source has no configurable
cleanup-reason filter.

- Successful cleanup calls removeFromCollection with notifyRemoval=false.
- Manual edits and media-server sync removals/adds retain default true.
- Rule-owned sync (rule-executor.service.js handleCollection) has two emitters for
  one change in the pinned source: the collection service (identifier `collection`) and the executor's
  verified delta (identifier `rulegroup`). The notification dispatcher resolves
  both to the same rule group and notifiers. The patched executor is the single
  owner: it passes
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

Credentials are read at runtime from private Maintainerr state. None are embedded
in the Nix store, source or logs. The reconciler uses non-secret desired JSON and
native API upserts keyed by name, preserving unmanaged resources. It does not
replace the SQLite database.

## Rollback / deployment

The [NixOS declaration](../maintainerr.nix) owns the image pin, patch preparation,
read-only mounts, and notifier reconciliation. Deploy through hoard's normal
NixOS activation workflow. The service prepares and verifies the patch before
starting the container, then reconciles the owned notifier after startup.

Rollback uses the corresponding NixOS configuration. The notifier is a separate
database record: remove only the owned failure notifier through Maintainerr's
native API if it is no longer wanted. Preserve notification history, rules, and
media state.
