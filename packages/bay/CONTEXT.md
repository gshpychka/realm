# Bay

Bay runs disposable, isolated sessions for terminal programs, including coding agents, on one workstation the operator drives.

## Language

### Sessions

**Session**:
The operator's unit of work: one program with its repos, credentials and history, which outlives any single instance.
_Avoid_: VM, sandbox, box, run

**Session record**:
What a session starts from: its program, the repos it can access and the commit each has checked out, the credentials it gets, and the program's history.
_Avoid_: spec, checkpoint, manifest

**Instance**:
The Incus VM backing a running or suspended session; used only when talking about Incus itself.

**Program**:
The one terminal program a session runs, usually a coding agent such as Claude Code.
_Avoid_: process, task

**Operator**:
The one person who launches, attaches to and removes sessions, and oversees every message between them.
_Avoid_: user, owner, admin

**Bay server**:
The host service that owns sessions and their records and exposes them through an API; the CLI and the app are its clients.
_Avoid_: controller, daemon, backend

**flare**:
The command inside a session that notifies the operator and sends and reads messages through the gateway.
_Avoid_: in-session bay

**Snapshot**:
A named copy of a running session's disk and memory, taken to roll back to later; it lives and dies with the session's instance.
_Avoid_: checkpoint, save point

### Session states

**Running**:
The session's instance is up.

**Suspended**:
The session's instance is saved with its disk and memory, ready to resume exactly where it was.

**Ended**:
The session has no instance; only its session record remains.
_Avoid_: stopped, terminated, closed

## Relationships

- A **Session** has exactly one **Session record** and at most one **Instance**
- A **Running** or **Suspended** session has an **Instance**; an **Ended** session has none
- **Snapshots** belong to an **Instance**, so ending a **Session** deletes them
- A **Session** runs exactly one **Program**, inside the session's tmux server
- Resuming a **Running** session whose **Program** has stopped starts the **Program** again
- A **Session**'s name is chosen by the **Operator**, unique across every session in the store, and is its messaging identity across every start
- The **Operator** launches every **Session**; there is one **Operator**

## Example dialogue

> **Dev:** "If I end a session, can I get back to the exact screen it had?"
> **Operator:** "No, suspend it for that. Ending keeps the **Session record**, so starting it again gives a fresh **Instance** with the same repos, credentials and history, and the **Program** picks up its conversation."

## Invariants

- A **Session** and its disposable **Instance** have different lifetimes. Ending destroys the workspace; suspending preserves it.
- A session record pins its machine revision, resource allocation, repository commits, and resolved program commands at creation.
- The stable record ID survives instance replacement; the host execution generation advances before a fresh launch or explicit resume. Snapshot restore cannot rewind host authority.
- The **Session** participates in Bay mail. Its **Program** may be a coding agent, a shell, or any terminal application.
- Names are readable addresses; record IDs own inboxes. Reusing a removed name grants no access to its earlier record's mail.
- The operator socket alone exposes machine lifecycle, immutable transfer, detached jobs, and the generic execution environment. The guest gateway exposes authenticated mail and notifications.
- The execution environment is unprivileged and connection-scoped. Model state, conversations, task recovery, and orchestration remain application responsibilities.
- There is one **Operator**. Repository owner means only the owner component of a repository's remote path.
- **flare** runs inside sessions; **bay** is the operator client.
