# Hermes on hoard

Hermes runs alongside OpenClaw under its own `hermes` account, using the
upstream NixOS module and full package through a normal unpinned flake input.
Host policy is in `../hermes-agent.nix`; reusable fleet options are under
`modules/system/nixos/hermes-agent/`. It is included in hoard's normal build.

## Deployment

Build and test from a machine with Nix and access to the flake's private inputs:

```sh
# Let Nix resolve the new input through the normal lock workflow.
nix flake lock
nix flake check --all-systems --no-build
nix build --no-link -L .#nixosConfigurations.hoard.config.system.build.toplevel
```

The branch deliberately leaves `flake.lock` unchanged. The build includes the
runtime, ACP wrapper and Git credential scoping checks. To test this branch
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
hermes-run python3 /path/to/realm/scripts/hermes-agent/runtime.py ready \
  --credential /var/lib/hermes/.hermes/api.env --port 8642
```

`ExecStartPost` performs that same authenticated `/health/detailed` request,
checks the Hermes platform and `status=ok`, and fails startup on timeout or
rejected credentials. This establishes service readiness, not model billing
or a successful provider login. Complete the functional checks below.

## Credentials and first use

Existing encrypted OpenAI, ElevenLabs, Home Assistant and owner-ID values
are reused from `secrets/hoard/openclaw.yaml`, under separate sops-nix names.
The GitHub App key is also reused; both agents commit as the same installed
bot. To separate the App later, configure `my.hermes-agent.github` and its
SOPS key. Secret values never appear in Nix-generated files in the store.

1. **Model login.** Run `hermes auth add openai-codex` on hoard. The
   `hermes` wrapper switches to the service account and sets its environment.
   The selected model is `gpt-6.1-sol`, matching OpenClaw. Hermes keeps its
   own mutable `auth.json`; external-login adoption is disabled. A raw copy
   of OpenClaw's auth store is not a supported migration format. Use a fresh
   login or upstream's supported import workflow. The API key remains
   available to tools and integrations; the main model uses the subscription.
2. **Telegram.** Create a new bot with BotFather. Copy
   `/etc/hermes-agent/telegram.env.example` to a private local file, set
   `TELEGRAM_BOT_TOKEN`, then install it as `/var/lib/hermes/telegram.env`,
   owned by `hermes:hermes`, mode `0600`. Restart `hermes-agent`. The existing
   owner's numeric ID is the only allowlisted user; groups are disabled.
   Without a bot token, the API still runs and Telegram is not connected.
   For a single-bot cutover, stop/disable the OpenClaw Telegram channel
   before transferring its token; two pollers cannot share one token.
3. **Speech.** Existing ElevenLabs credentials drive Scribe v2 and Eleven v4.
   Move the current voice ID into
   `services.hermes-agent.settings.tts.elevenlabs.voice_id`. Use `/voice on`
   in Telegram for spoken replies to voice notes. Detailed OpenClaw voice
   stability/similarity/speed controls do not map to Hermes' current API.
4. **Coding subscriptions.** Sign in separately with
   `hermes-run env -u OPENAI_API_KEY -u CODEX_API_KEY codex login` and
   `hermes-run claude`, then
   `/login` in Claude. For a supported migration, copy only the tools'
   compatible authentication files with private ownership and permissions;
   do not share writable token stores between two service identities.
   Fleet skills clear inherited API credentials when invoking personal plans.
   `hermes-run` runs any command as the service user with the actual service
   PATH and current environment, including installed coding tools.
   Claude's effort and Remote Control behavior use its own defaults and any
   user/project settings; this deployment does not manage those preferences.
5. **Encrypted files.** See `secrets/hermes/README.md` to enrol Hermes' own
   generated age recipient. Reused host SOPS values work independently of
   this optional agent-owned decryption identity.

For declarative Telegram secrets, encrypt a dedicated bot token in a SOPS
source and map `TELEGRAM_BOT_TOKEN` through `my.hermes-agent.secrets`, or
replace the optional environment file with a SOPS-rendered environment file.
Do not put plaintext tokens into the example file, Nix settings or git.
After rotating extra runtime-file values, restart both Hermes services.

## Interfaces and state

| Location | Purpose |
| --- | --- |
| `/var/lib/hermes/.hermes/config.yaml` | Upstream merges Nix-owned keys while preserving other runtime settings |
| `/var/lib/hermes/.hermes/.env` | Private environment refreshed atomically from current SOPS/runtime files at each service start |
| `/var/lib/hermes/.hermes/auth.json` | Hermes' own provider login and refresh state |
| `/var/lib/hermes/.hermes/api.env` | Generated private local API key, preserved on restart |
| `/var/lib/hermes/.hermes/SOUL.md` | Living personality document, maintained outside this repository |
| `/var/lib/hermes/.hermes/memories/` | Mutable learned `MEMORY.md` and `USER.md` |
| `/var/lib/hermes/.hermes/state.db` | Session state and searchable history |
| `/var/lib/hermes/.hermes/skills/realm/` | Declarative fleet skills; Hermes can learn other skills separately |
| `/var/lib/hermes/.hermes/cron/` | Persistent native scheduled jobs |
| `/var/lib/hermes/workspace/repositories/` | Coding checkouts |
| `/var/lib/hermes/workspace/tasks/` | Scratch work and artifacts |
| `/var/lib/hermes/workspace/AGENTS.md` | Living workspace instructions, maintained outside this repository |
| `/var/lib/hermes/age-key.txt` | Optional independent SOPS identity |
| `/var/lib/hermes/.codex/`, `.claude/`, `.acpx/` | Coding tools' separate login and persistent ACP session state |

The API binds only to `127.0.0.1:8642` and supports Hermes' OpenAI-compatible
chat and Responses interfaces. Its 48-byte random key is generated on first
start, stored with mode `0600`, and passed through systemd, not process
arguments. Consumers should read it locally without printing it. Stop the
gateway before rotating/removing the file and update authorized consumers.

The dashboard binds only to `127.0.0.1:9119`. Access it through an SSH tunnel:

```sh
ssh -L 9119:127.0.0.1:9119 hoard
```

Open the dashboard on the forwarded port locally. No firewall opening, DNS
record or reverse proxy is added. A future network-facing dashboard must use
Hermes' own OIDC authentication (the inspected upstream supports self-hosted OIDC,
including Authelia). Setting only trusted-proxy headers does not configure
Hermes authentication, and setting `dashboard.public_url` without an auth
provider makes upstream refuse startup.

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
| Telegram owner DMs | Owner allowlist, groups disabled, separate bot placeholder |
| ChatGPT model subscription | Native `openai-codex` provider; independent login |
| ElevenLabs incoming notes and spoken replies | Scribe v2 / Eleven v4; voice ID is a migration input; fewer voice controls |
| Home Assistant Assist and admin MCP | Both endpoints, including environment interpolation for credentials |
| GitHub App git/gh identity | Same App, independent service-owned key binding, origin-scoped helper |
| Claude Code and Codex | Persistent Claude/Codex ACP sessions via the existing acpx closure, plus native CLIs; separate logins |
| OneDrive read/write | Existing shared sync group/tree, no duplicate sync process |
| Memory and skills | Hermes-native memory, SQLite session search and learned skills; curated migration, no vector-index import |
| Scheduled jobs | Native persistent cron with a lingering user manager |
| UI / HTTP access | SSH-forwarded dashboard plus authenticated local API |
| Agent-owned SOPS files | Own generated age key and recipient enrolment scaffold |
| Root / TPM key | Same host TPM signing identity through explicit per-user socket ACLs and PAM-authenticated sudo |
| Owner-authorized NixOS native control | OpenClaw-only; no speculative Hermes authorization shim |
| Voice PE live broker | Remains on OpenClaw; needs a real Hermes session/history/observer adapter |
| OpenClaw Codex migration routing / queued-media patch | Application-specific behavior remains on OpenClaw |

Hoard's TPM service remains owned by OpenClaw. The new
`my.tpmSshKey.extraUsers` option grants Hermes socket access with a specific
ACL reapplied after each agent restart; it exports no private key and grants
no access to other users. Both accounts can use the same signing identity.
Other hosts leave `my.hermes-agent.root = null` unless they deliberately
provision an agent socket and public key. To remove Hermes' root access on
hoard, set its `root = null` and remove its `extraUsers` entry together.

Migrate personality and durable facts into Hermes' own formats after review;
copying session databases, cron files or OpenClaw plugins will not convert
them. Living documents stay outside this repository for both agents:
OpenClaw's main workspace is `/var/lib/openclaw/workspace/`, including its
`SOUL.md`, `AGENTS.md` and memory; Hermes uses the paths listed above.
Create and edit these files directly in persistent state as the owning agent
user. Nix does not seed, replace or delete them. Removing the earlier Hermes
document declarations preserves any copies already installed on hoard.
Fleet integration skills remain declarative configuration in the repo;
agent identity, user profiles, personal notes and learned memory do not.
Back up the whole service home, coding logins, age key and local bot file as
sensitive data while services are stopped; SQLite online backup is an option
for live database snapshots. Restores must preserve ownership and modes.

## Functional checks and rollback

After supplying the logins/bot/voice identity, verify an actual model reply,
an owner Telegram DM, rejection from a different Telegram account, a voice
note and voice reply, listing exposed HA entities, a read-only admin MCP
query, `git ls-remote`, a read-only `gh api` query against an installed
repository, an authenticated coding-tool query,
and a temporary OneDrive file round trip. Verify `sudo -n true` as Hermes to
exercise the TPM/PAM path. Schedule a harmless cron job,
restart the gateway, and verify its persisted result. Only test writes and
home-control actions with the owner's authorization. The API health check
alone does not establish these integrations work.

For a code-only check in a development environment:

```sh
python3 -m unittest discover -s scripts/hermes-agent/tests -v
```

To roll back, stop both `hermes-agent` and `hermes-backend`, set
`my.hermes-agent.enable = false` in the hoard module and rebuild, or use the
previous NixOS generation. Persistent state
is retained for diagnosis or re-enabling. OpenClaw and its voice broker remain
the current production path until each intended replacement is verified.
