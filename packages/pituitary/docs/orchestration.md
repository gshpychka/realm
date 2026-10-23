# Pituitary: a durable agent workspace

## Design

Pituitary gives an operator one objective, a team of declared agents, and a reviewable
result with evidence. Work survives a closed terminal, a reloaded frontend, and a
restarted host runtime.

This is a greenfield system. The design describes its steady state. There are no
compatibility backends, schema migrations, or alternate recovery implementations.
Delete custom machinery when the upstream runtime already owns the concern.

The architectural centre is one **Pi Durable Harness on the host**. Each agent is one
native conversation bound to a declared NixOS execution environment in Bay. Models run
through the host's Pi AI registry; file and shell tools run in that environment.
Provider credentials stay on the host.

An agent declaration names both its role and its real environment. Nix describes
available capabilities. The runtime creates instances within the operator's declared
scope; a model cannot invent machines, credentials, or authority.

## Ownership

| Module | Owns |
| --- | --- |
| Pi Durable | Conversations, transcripts, model generations, tool tasks, inboxes, submissions, checkpoints, ownership, cancellation, recovery, usage |
| Pituitary domain | Objectives, task revisions, frozen roles, authority, budgets, questions, reports, input provenance, artifacts, integration, acceptance |
| Bay | NixOS instances, record and execution identity, machine revisions, resource admission, files, commands, immutable transfers, snapshots |
| Terminal UI | Conversation presentation, team navigation, drafts, attention, operator input lease, display pacing |

Pituitary business facts are typed native Documents. Its background workflows are
native Tasks. They commit intent before effects, keep checkpoints between phases, and
use native task IDs as external idempotency keys. There is one conversation database
and one scheduler. There is no second outbox, worker daemon, conversation journal,
inbox ledger, transcript archive, or recovery protocol.

Bay is independent of Pi. Its environment connector is a fixed unprivileged helper,
with ephemeral file handles and command processes. It contains no model, agent
scheduler, or conversation state.

## Agent declarations

~~~nix
services.pituitary = {
  enable = true;
  operator = "alice";

  credentialProfiles.primary = {
    provider = "anthropic";
    file = "/run/secrets/agent-api-key";
  };

  limits = {
    maxTasks = 16;
    maxLiveAttempts = 4;
    maxDepth = 2;
  };

  agents = {
    coordinator.pituitary.agent = {
      description = "Plan, delegate, and assemble the result.";
      instructions = builtins.readFile ./agents/coordinator.md;
      model = "anthropic/your-model";
      credentials = [ "primary" ];
      delegatesTo = [ "builder" "reviewer" ];
      limits = { maxChildren = 4; maxDepth = 2; };
    };

    builder = { pkgs, ... }: {
      imports = [ ./agents/development-machine.nix ];
      environment.systemPackages = [ pkgs.bun pkgs.go ];
      pituitary.agent = {
        description = "Implement one result from an exact input.";
        instructions = builtins.readFile ./agents/builder.md;
        model = "anthropic/your-model";
        credentials = [ "primary" ];
        verification = {
          agent = "verifier";
          checks.unit = {
            command = [ "bun" "test" ];
            timeoutMs = 300000;
          };
        };
      };
    };

    reviewer = {
      imports = [ ./agents/development-machine.nix ];
      pituitary.agent = {
        description = "Challenge the result and its evidence.";
        instructions = builtins.readFile ./agents/reviewer.md;
        model = "anthropic/your-model";
        credentials = [ "primary" ];
        tools = [ "read" "grep" "find" "ls" ];
      };
    };

    verifier = { pkgs, ... }: {
      environment.systemPackages = [ pkgs.bun pkgs.go ];
    };
  };
};
~~~

Each entry is an ordinary NixOS module: imports, packages, services, and role metadata.
The role catalog is separate from the image. Editing instructions, models, tools, or
verification commands does not rebuild a machine. Editing system dependencies does.
Equal images and resource allocations share an immutable warm base.

The runtime loads trusted resolved JSON, never arbitrary repository TypeScript or Nix.
New runs load the current catalog; each run freezes its reachable roles and verifier
definitions. Declaring an agent does not start it.

Credential profiles contain runtime file references, never key material in the Nix
store. One profile identifies each provider. A role names its allowed profiles; host
model admission checks those names. Secrets are read from their runtime files and
never sent to Bay. Verifiers need no model credentials.

## Work and identity

| Concept | Meaning |
| --- | --- |
| Run | One operator objective, input workspace, frozen role catalog, and aggregate limits |
| Task | A result to produce, with a revision, acceptance conditions, and exact dependency results |
| Attempt | One execution of a task revision, its native conversation, and its pinned environment |
| Agent definition | A named role and NixOS execution environment |
| Artifact | Immutable retained bytes with exact Git base, head, tree, and content identities |
| Integration | A merge of one retained contribution against an exact integration base |
| Verification | Declared commands executed against an exact integrated tree in a fresh environment |

Names help people navigate. Immutable IDs establish ownership. Every remote operation
pins the Bay record ID, execution generation, and machine revision. Restoring guest
memory does not restore host authority. A changed generation interrupts the old
environment instead of silently adopting it.

Task result state, native conversation activity, and Bay instance state are separate
facts. An idle conversation has not necessarily submitted a result. A disconnected
frontend has not cancelled anything. A passing paragraph has not verified code.

## Native workflows

A background agent Task owns its conversation and environment. Its phases capture an
input, provision the environment, materialize the checkout, submit the objective, wait
for a durable result, retain any code, and suspend the environment. The native ownership
tree carries cancellation through the work it owns.

Tools stay small:

- **delegate** creates a child from an allowed definition and returns its identity.
- **inspect** reads relevant work and explains its current state.
- **message** submits attributed context to another allowed conversation.
- **ask** records an operator question and ends the current model turn.
- **submit** records an immutable report and optionally requests code retention.
- **yield** ends the model turn while waiting for relevant work.

These tools use native tool task identities and safe replay only where external
effects have stable receipts. Answers and peer messages use native submission
request IDs. They cannot create authority through their prose.

A child never holds a parent's model tool call open while waiting for that parent.
Questions, reports, and replies become durable submissions at native turn boundaries.
There are no polling model turns.

Shell execution is not replay-safe merely because a task is durable. A severed remote
environment connection kills its command group. Pi Durable records an interrupted
unsafe tool rather than blindly executing it again. Provisioning and artifact jobs
use stable IDs and exact payload receipts. An unknown create result is reconciled
against its deterministic session name; absence after an ambiguous dispatch is not
permission to create again.

## Bay execution environments

The host implements Pi Durable's ExecutionEnv interface over Bay's fixed environment
connection. File readers own real guest file descriptors, so a renamed path cannot
change an already-open read. Directory readers, bounded binary chunks, and streamed
shell output use that same connection.

The helper runs as the session user. It receives no Incus socket or model credentials.
Its connection is fenced to the record, generation, and machine. Lifecycle changes
retire connections. Disconnect cleanup kills the command's process group and closes
its handles. File watching reports unsupported when the environment cannot provide it.

Durable materialization, export, and verification use separate operator jobs. Job
receipts and immutable transfer files are protected from the guest's session user.
Replaying a job ID returns the same receipt; a different payload conflicts. Interrupted
jobs remain inspectable and are not automatically dispatched again.

Bay's human mail, terminal programs, suspend/resume, and snapshots remain ordinary Bay
features. Pituitary agent collaboration uses native durable conversations.

## Code and artifacts

A run has one primary writable workspace. Additional repository inputs are read-only
context. A local or private source does not require a GitHub push.

Input capture reads tracked working files, including staged additions and unstaged
changes, plus explicitly selected untracked files. Ignored untracked material is
excluded. Capture preserves the operator's branch, index, and files. It creates a
private synthetic Git commit representing the exact input tree, and records the
operator's HEAD and index digest as apply preconditions.

Every writer gets a separate checkout from its immutable input. Export runs after its
model turn settles and creates a constrained Git bundle against that input. The host
bounds the transfer, validates the bundle and tree in its private object store with
hooks and filters disabled, retains content-addressed bytes durably, and only then
acknowledges the result. Suspension cannot substitute for artifact retention.

One integration workflow serializes contributions. A merge names its expected base
and current task revision. A stale result may remain history, but cannot advance the
integration pointer. Conflicts retain both contributions and explicit paths.

Retrying or revising upstream work invalidates dependent result authority, including
results whose input snapshots contain that contribution. Integration is rebuilt from
the original input and the current valid contributions; obsolete code cannot remain
accepted merely because later checks happen to pass.

Reports are context. Code retention, integration, verification, and acceptance are
distinct facts.

## Verification and acceptance

A verification policy names a declared verifier environment and fixed argv commands.
A fresh Bay instance materializes the exact integrated artifact and executes those
commands without a model or credentials. Evidence records command names, bounded
output, exit results, the tested tree, policy digest, and exact environment identity.
The source tree is checked before and after every command.

Acceptance requires all configured checks to pass for the current integration tree,
task revision, dependency results, policy, and verifier identity. Changed integration
invalidates old evidence. Missing policy leaves code explicitly unverified. A model's
reported test outcome never counts as independent evidence.

A run completes when its required tasks have submitted their reports or accepted code,
its current integration has matching evidence, and no operator question remains open.

Applying the accepted result is an explicit operator command. It checks that the
operator's HEAD, index, and working input still match the captured provenance, then
applies a binary diff without changing the branch or index. Apply intent and outcome
are durable. An uncertain partial apply is inspected, never blindly repeated.

## Operator experience

The main view is one conversation. Compact delegation cards or a wide task sidebar
show objective, status, waiting reason, and result evidence. A task switcher and back
navigation preserve each draft and viewport. Opening another agent observes it;
joining its input lease is explicit.

Attention collects durable questions. Answers bind to the current task revision and
attempt. Results show retained code, integration conflicts, named checks, and the
specific tree the evidence covers. Applying code is offered only for the current
accepted run result.

The frontend is disposable. Managed source watch closes its native subscriptions,
saves private draft and viewport state, tears down the renderer, and asks the launcher
to restart only the UI. The host harness and Bay environments keep their lifetimes.

The private runtime Unix socket carries commands and bounded conversation event
streams. Each attachment begins with a native atomic snapshot and then committed
events. Slow observers detach and reconnect to a new snapshot. There is no token
replay database. The same client works through an SSH Unix-socket tunnel from Eve.

## Development and evidence

Source UI, host application code, role prompts, and resolved catalogs iterate without
a system rebuild. Only changes to the declared machine environment require rebuilding
that image. A run's frozen identities remain explicit.

Treat validation as expensive. Implement and review a coherent end-to-end milestone,
then run its relevant gates together. Use focused reruns to diagnose concrete failures.

Provider-free evidence covers native durability and ownership, remote filesystem and
command conformance, interrupted execution, duplicate submissions, fenced generations,
dirty input capture, parallel merges, stale dependencies, cancellation, fresh-tree
verification, unchanged operator indexes, and the full operator result flow.

Inspect compact and wide rendered screenshots and terminal behavior. Measure input
latency with background work. Exercise Bay lifecycle and the environment helper in
real nested VM tests. No terminal emulator identity is assumed at runtime.

Bay and Pituitary deployment on reaper is declared separately from this architecture.
Enabling services, activating a host configuration, and publishing a result remain
explicit operator actions.
