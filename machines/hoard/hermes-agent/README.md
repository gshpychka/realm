# Hermes on hoard

Hermes runs alongside OpenClaw under its own `hermes` account, using the
upstream NixOS module and full package. The flake input follows upstream;
the Nix-generated `flake.lock` pins the revision used by builds.
Host policy is in `../hermes-agent.nix`; reusable fleet options are under
`modules/system/nixos/hermes-agent/`. It is included in hoard's normal build.

## Deployment

Build and test from a machine with Nix and access to the flake's private inputs:

```sh
nix flake check --all-systems --no-build
nix build --no-link -L .#nixosConfigurations.hoard.config.system.build.toplevel
```

Nix resolves the upstream revision through the generated `flake.lock`.
Refresh it with the normal Nix commands when upgrading Hermes. The build
includes the Git credential scoping check. To test this branch
before merging, use a checkout of the branch and the normal deployment:

```sh
nixos-rebuild test --flake .#hoard --target-host hoard --sudo
# After checking the service, persist it through reboot:
nixos-rebuild switch --flake .#hoard --target-host hoard --sudo
```

The existing `nixos-switch` controller deliberately accepts main's revisions;
it is not a branch deployment path. No live deployment is performed by adding
this configuration. Host SOPS decryption must already work.

Inspect startup and exercise the local authenticated API on hoard:

```sh
sudo systemctl status hermes-agent hermes-backend
sudo journalctl -u hermes-agent -u hermes-backend -n 100 --no-pager
sudo -iu hermes hermes doctor
```

As in OpenClaw, a short `ExecStartPost` shell check establishes readiness.
It calls the authenticated `/health/detailed` endpoint, checks the Hermes
platform and `status=ok`, and fails startup after 120 seconds if unsuccessful.
This does not establish a successful model login or working integrations;
complete the functional checks below.

## Credentials and first use

Existing encrypted OpenAI, ElevenLabs, Home Assistant and owner-ID values
are reused from `secrets/hoard/openclaw.yaml`, under separate sops-nix names.
The GitHub App key is also reused; both agents commit as the same installed
bot. To separate the App later, configure `my.hermes-agent.github` and its
SOPS key. Secret values never appear in Nix-generated files in the store.

The native module installs Hermes and its tools in the service user's
profile. Run administrative CLI commands with `sudo -iu hermes`; no custom
CLI wrapper is needed. Hermes loads its own private `.env`.

1. **Model login.** Run `sudo -iu hermes hermes auth add openai-codex` on hoard.
   The selected model is `gpt-6.1-sol`, matching OpenClaw. Hermes keeps its
   own mutable `auth.json`; external-login adoption is disabled. A raw copy
   of OpenClaw's auth store is not a supported migration format. Use a fresh
   login or upstream's supported import workflow. The API key remains
   available to tools and integrations; the main model uses the subscription.
2. **Telegram.** Create a separate bot with BotFather and add its token as
   `hermes-telegram-bot-token` in `secrets/hoard/openclaw.yaml` using SOPS,
   before deployment. This encrypted key is a provisioning prerequisite;
   it is not present in this scaffold. The existing owner's numeric ID is
   the only allowlisted user; groups are disabled by native Hermes policy.
   For a single-bot cutover, stop/disable OpenClaw's Telegram channel and
   change the Hermes mapping to the existing `telegram-bot-token` key;
   two pollers cannot share one token.
3. **Speech.** Existing ElevenLabs credentials drive Scribe v2 and Eleven v4.
   Move the current voice ID into
   `services.hermes-agent.settings.tts.elevenlabs.voice_id`. Use `/voice on`
   in Telegram for spoken replies to voice notes. Detailed OpenClaw voice
   stability/similarity/speed controls do not map to Hermes' current API.
4. **Coding subscriptions.** Sign in separately with
   `sudo -iu hermes codex login` and `sudo -iu hermes claude`, then
   `/login` in Claude. For a supported migration, copy only the tools'
   compatible authentication files with private ownership and permissions;
   do not share writable token stores between two service identities.
   Hermes ships `claude-code` and `codex` skills that invoke those CLIs through
   its native terminal/process tools. Git and tmux are installed for their
   repository and interactive-session workflows. No ACP adapter is configured.
   When using Codex's subscription instead of an inherited API key, invoke it
   with `env -u OPENAI_API_KEY -u CODEX_API_KEY codex ...` as appropriate.
   Claude's effort and Remote Control behavior use its own defaults and any
   user/project settings; this deployment does not manage those preferences.
5. **Encrypted files.** See `secrets/hermes/README.md` to enrol Hermes' own
   generated age recipient. Reused host SOPS values work independently of
   this optional agent-owned decryption identity.
6. **Dashboard login.** The username is `glib`. The password and stable
   session-signing secret reuse the existing encrypted `gateway-token`,
   which also authenticates the local API. Hermes's native password provider
   handles hashing, login and browser sessions. To provision separate values,
   add encrypted keys and override their `my.hermes-agent.secrets` mappings.

All these environment credentials follow OpenClaw's SOPS template pattern.
The native Hermes module copies the private template to `.env` during NixOS
activation, after `setupSecrets`. Apply secret changes with a rebuild or
reactivation; restarting a service alone does not refresh that copy. Never
put plaintext tokens in Nix settings or git.

## Interfaces and state

| Location | Purpose |
| --- | --- |
| `/var/lib/hermes/.hermes/config.yaml` | Upstream merges Nix-owned keys while preserving other runtime settings |
| `/var/lib/hermes/.hermes/.env` | Private environment prepared by upstream activation from SOPS and declared environment |
| `/var/lib/hermes/.hermes/auth.json` | Hermes' own provider login and refresh state |
| `/var/lib/hermes/.hermes/SOUL.md` | Living personality document, maintained outside this repository |
| `/var/lib/hermes/.hermes/memories/` | Mutable learned `MEMORY.md` and `USER.md` |
| `/var/lib/hermes/.hermes/state.db` | Session state and searchable history |
| `/var/lib/hermes/.hermes/skills/realm/` | Declarative fleet skills; Hermes can learn other skills separately |
| `/var/lib/hermes/.hermes/cron/` | Persistent native scheduled jobs |
| `/var/lib/hermes/workspace/repositories/` | Coding checkouts |
| `/var/lib/hermes/workspace/tasks/` | Scratch work and artifacts |
| `/var/lib/hermes/workspace/AGENTS.md` | Living workspace instructions, maintained outside this repository |
| `/var/lib/hermes/age-key.txt` | Optional independent SOPS identity |
| `/var/lib/hermes/.codex/`, `.claude/` | Coding tools' separate login and native session state |

The API binds only to `127.0.0.1:8642` and supports Hermes' OpenAI-compatible
chat and Responses interfaces. Its key is the existing SOPS `gateway-token`,
supplied through the native environment configuration. No separate key file
or key-generation helper is used. Update authorized consumers when rotating
the encrypted credential, then rebuild/reactivate the host.

After deployment and credential provisioning, the dashboard is available at
`https://hermes.hoard.glib.sh` through the same web gateway as OpenClaw.
The backend remains on `127.0.0.1:9119`; nginx supplies TLS and WebSocket
proxying. Hoard's existing wildcard LAN DNS and certificate cover the name.
This adds no Cloudflare tunnel or Internet ingress.

Hermes's built-in password provider handles the login form, session cookies
and WebSocket authentication. `dashboard.public_url` activates its auth gate
even though nginx connects over loopback. It refuses to start if the native
login is unconfigured. No custom authentication adapter is installed.

The upstream module enables lingering for the Hermes user so cron dispatch
can run in transient user scopes and survive a gateway restart. Hermes has a
3 GiB gateway limit and 1 GiB dashboard limit, in addition to OpenClaw's 6 GiB;
watch hoard's memory budget alongside the media services. Hoard opts into
TPM-authenticated sudo parity, which explicitly relaxes no-new-privileges
and read-only-system restrictions for the gateway and dashboard subprocesses.
Without root configured, upstream write restrictions remain, with OneDrive
explicitly added as a writable path when that integration is enabled.

## Parity and remaining differences

| Existing capability | Hermes deployment |
| --- | --- |
| Declarative Nix package/config, service lifecycle, private state | Upstream package/module; journal logging, restart/readiness checks, resource limits |
| Telegram owner DMs | Native owner allowlist, groups disabled; provision a separate bot in SOPS |
| ChatGPT model subscription | Native `openai-codex` provider; independent login |
| ElevenLabs incoming notes and spoken replies | Scribe v2 / Eleven v4; voice ID is a migration input; fewer voice controls |
| Home Assistant Assist and admin MCP | Both endpoints, including environment interpolation for credentials |
| GitHub App git/gh identity | Same App, independent service-owned key binding, origin-scoped helper |
| Claude Code and Codex | Hermes's bundled CLI skills, native terminal/process tools and tmux; separate logins |
| OneDrive read/write | Existing shared sync group/tree, no duplicate sync process |
| Memory and skills | Hermes-native memory, SQLite session search and learned skills; curated migration, no vector-index import |
| Scheduled jobs | Native persistent cron with a lingering user manager |
| UI / HTTP access | TLS dashboard at hermes.hoard.glib.sh with native login, plus authenticated local API |
| Agent-owned SOPS files | Own generated age key and recipient enrolment scaffold |
| Root / TPM key | Same host TPM signing identity through native systemd socket/group permissions and PAM-authenticated sudo |
| Owner-authorized NixOS native control | OpenClaw-only; no speculative Hermes authorization shim |
| Voice PE live broker | Remains on OpenClaw; needs a real Hermes session/history/observer adapter |
| OpenClaw Codex migration routing / queued-media patch | Application-specific behavior remains on OpenClaw |

Hoard's TPM service remains owned by OpenClaw. The new
`my.tpmSshKey.extraUsers` option adds Hermes to the socket's explicit access
group. Native systemd socket activation creates the socket with its final
permissions and keeps it available across daemon restarts. Both accounts
use the same signing identity; the non-exportable private key stays in the TPM.
Hermes uses the same PAM SSH-agent authentication and sudo rule as OpenClaw;
`SSH_AUTH_SOCK` reaches its gateway, dashboard and coding subprocesses.
Hoard also sets Hermes's native `approvals.mode = "off"` to match OpenClaw's
unattended host-exec policy. This does not change the coding CLIs' own settings.
Other hosts leave `my.hermes-agent.root = null` unless they deliberately
provision an agent socket and public key. To remove Hermes' root access on
hoard, set its `root = null` and remove its `extraUsers` entry together.

Migrate personality and durable facts into Hermes' own formats after review;
copying session databases, cron files or OpenClaw plugins will not convert
them. Living documents stay outside this repository for both agents:
OpenClaw's main workspace is `/var/lib/openclaw/workspace/`, including its
`SOUL.md`, `AGENTS.md` and memory; Hermes uses the paths listed above.
Create and edit these files directly in persistent state as the owning agent
user. Nix does not seed, replace or delete them. This scaffold has not been
deployed; no live documents have been migrated.
Fleet integration skills remain declarative configuration in the repo;
agent identity, user profiles, personal notes and learned memory do not.
Back up the whole service home, coding logins and age key as
sensitive data while services are stopped; SQLite online backup is an option
for live database snapshots. Restores must preserve ownership and modes.

## Functional checks and rollback

After supplying the logins/bot/voice identity, verify an actual model reply,
the dashboard login and rejection of unauthenticated API/WebSocket access,
an owner Telegram DM, rejection from a different Telegram account, a voice
note and voice reply, listing exposed HA entities, a read-only admin MCP
query, `git ls-remote`, a read-only `gh api` query against an installed
repository, an authenticated coding-tool query,
and a temporary OneDrive file round trip. Verify
`sudo -iu hermes env SSH_AUTH_SOCK=/run/tpm-ssh-agent/agent.sock sudo -n true`
and `sudo -n true` through Hermes's Telegram and dashboard terminals to
exercise the TPM/PAM path in each runtime context. A raw login shell needs
the socket variable explicitly; Hermes loads it from its native `.env`.
Schedule a harmless cron job,
restart the gateway, and verify its persisted result. Only test writes and
home-control actions with the owner's authorization. The API health check
alone does not establish these integrations work.

To roll back, stop both `hermes-agent` and `hermes-backend`, set
`my.hermes-agent.enable = false` in the hoard module and rebuild, or use the
previous NixOS generation. Persistent state
is retained for diagnosis or re-enabling. OpenClaw and its voice broker remain
the current production path until each intended replacement is verified.
