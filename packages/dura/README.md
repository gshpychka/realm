# Dura

**Declare the team. Keep the work. Bring back verified code.**

Dura orchestrates durable agents, with [Pituitary](../pituitary) as its terminal
frontend. It gives agents native Pi Durable conversations, uses [Bay](../bay) for
their NixOS machines, and retains code with independent verification against the
exact integrated tree.

[Declare agents](../../agents) · [Host configuration](../../machines/reaper/dura.nix) ·
[Architecture](docs/orchestration.md) · [CLI](src/main.ts)

## Start here

[Enable a host and declare your team](../../agents#connect-the-team-to-a-host).
Reaper's [declaration](../../machines/reaper/dura.nix) imports the starter coordinator,
builder, reviewer, and verifier. On that host, from a Git project:

```sh
dura agents
dura run --agent coordinator --name feature --workspace "$PWD" \
  'Fix the parser bug, add a regression test, and have the change reviewed'
```

Pituitary opens on the coordinator. Dura captures tracked working files, delegates
into isolated checkouts, retains contributions, and runs the declared checks in a
fresh verifier machine. Add untracked inputs deliberately with `--include-untracked PATH`.

```mermaid
flowchart LR
  Objective[Your objective] --> Team[Declared agents]
  Team --> Code[Retained code]
  Code --> Verifier[Fresh verifier]
  Verifier --> Result[Verified result]
  Result --> Apply[You apply]
```

Closing the frontend leaves work running. Reconnect, inspect, and apply:

```sh
dura runs
dura attach feature
dura inspect feature
dura apply feature
git diff
```

Apply requires current passing checks and an unchanged source checkout. Review,
commit, and push through your normal workflow. Reports, retained code, integrated
code, and verified code remain distinct facts.

## Authentication and configuration

Pituitary's `/login` connects your provider through regular Pi. Dura reuses Pi's
native auth store on the host, including subscription OAuth and refresh:

```nix
services.dura = {
  enable = true;
  operator = "alice";
  authFile = "/home/alice/.pi/agent/auth.json";
  model = "openai/gpt-6.1-sol";
  credentialProfiles.primary.provider = "openai";
  agents = import ./agents;
};
```

Choose the provider and model available to your account. `authFile` contains runtime
credentials and stays outside the Nix store. Profiles grant provider access; roles
name the grants they need. Credentials never enter guest machines. The verifier
runs fixed commands and needs no model or credentials.

Each agent is an ordinary NixOS module with `dura.agent` metadata. Packages and
services define its machine; instructions, tools, delegation, and checks define its
role. Role edits do not rebuild images. Equal machines share a warm base while
running as separate instances. The [agent guide](../../agents) explains the declaration.

## Work with a run

| Action | Command |
| --- | --- |
| Inspect state and evidence | `dura inspect RUN` or `--json` |
| Answer an operator question | `dura answer QUESTION 'answer'` |
| Retry the current revision | `dura retry TASK --revision N` |
| Refine the objective | `dura revise TASK --revision N 'objective'` |
| Integrate retained code | `dura integrate TASK --revision N` |
| Apply verified code | `dura apply RUN` |
| Retry a parked workflow | `dura recover RUN` |
| Cancel work, retaining history and workspaces | `dura stop RUN` |

`--detach` starts without opening a terminal. `--repo OWNER/NAME@REF` adds repository
context. `--socket PATH` connects to an existing host, including an SSH Unix-socket
tunnel. `--state DIR` selects host state. `dura --help` lists all options.

## Develop

```sh
nix develop .#dura
bun install
bun packages/dura/src/main.ts attach RUN --watch
```

Source runs use checkout-local state. The frontend reloads independently; host
application edits require restarting the host. Native tasks resume from checkpoints.
New runs freeze the current catalog. Machine package changes rebuild their image.

| Code | Owns |
| --- | --- |
| [`src/orchestrator.ts`](src/orchestrator.ts) | Native workflows and domain authority |
| [`src/model.ts`](src/model.ts) | Runs, tasks, artifacts, evidence |
| [`src/client.ts`](src/client.ts) | Pure connection client; no server bootstrap |
| [`src/supervisor.ts`](src/supervisor.ts) | Host API and runtime lifecycle |
| [`agent-module.nix`](agent-module.nix) | Declarative role options |

Dura launches the Pituitary executable rather than importing its renderer. The
frontend imports only `@realm/dura/client` and `@realm/dura/types`. Regular Pi and
Dura share presentation through Pituitary's `ConversationLink`, with separate
runtime ownership and configuration.

See the [architecture](docs/orchestration.md) for the complete state and ownership model.
