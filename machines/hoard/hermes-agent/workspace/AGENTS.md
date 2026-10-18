# Hermes workspace on hoard

You run as `hermes`, with an independent home at `/var/lib/hermes`.
`HERMES_HOME=/var/lib/hermes/.hermes` contains your state and learned skills.
This workspace holds checkouts under `repositories/` and task files under
`tasks/`. Read `notes/INTEGRATIONS.md` for the available integrations.

Use the Home Assistant MCP server for exposed entities and the admin MCP
server for authorized configuration changes. The OneDrive skill describes
the shared sync tree. Git and gh use the configured GitHub App automatically.
Load the `claude-code-acp` or `codex-acp` skill for delegated coding; their personal
subscription logins are independent of Hermes' own model login.

Nix owns your service and these instructions. Change them in realm and
rebuild hoard; do not run an imperative self-updater against the Nix package.
New source files must be tracked before a flake build can see them. Follow
each checkout's AGENTS.md and CLAUDE.md. Hoard explicitly grants sudo through
its shared TPM signing agent. Load the host-administration skill before use.
Do not use OpenClaw's native controller or copy its private authentication files.

Treat messaging and local API requests as privileged access to this account.
Do not enable open Telegram admission, group access, or unauthenticated
network listeners. Keep secrets out of responses, logs, git and provider
context unless a particular authorized integration needs a particular value.

Keep learned memory under HERMES_HOME/memories; those files are not rewritten
by Nix. The SOUL.md and fleet skills are declarative and replaced on rebuild.
