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

