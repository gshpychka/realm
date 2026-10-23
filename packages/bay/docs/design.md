# Bay's session boundary

Bay provides isolated NixOS machines for one operator. Terminal programs run in
persistent tmux sessions; operator applications can also use a machine's files
and processes directly. Bay owns machine lifecycle and isolation. Applications
own their models, conversations, tasks, and interpretation of results.

## Machine declarations and session records

The NixOS module declares machine images and program definitions. An immutable
warm base identifies the image artifacts and CPU, memory, and disk allocation.
Preparing one revision neither replaces another base nor deletes its image.
Programs select a declared machine; ordinary shell sessions use `default`.

A new session records its stable ID, machine revision, resources, resolved
program commands, and repository commits before creating an Incus instance.
Later configuration changes affect new sessions. Starting an ended session uses
its pinned declaration and program history. Running and starting sessions count
against both the session limit and the sum of their pinned memory allocations.
Suspended sessions retain disk and memory state without consuming admission.

The session record outlives its disposable instance. `suspend` preserves the
instance, including its workspace. `end` saves configured program history and
**destroys the instance's workspace**; `rm` also removes the record. Applications
must retain results durably before ending an instance. Bay never assumes that
program history contains unpublished work.

Every fresh instance and explicit resume advances a host-persisted execution
generation before the operation. Restoring guest snapshots cannot rewind that
authority. Record IDs prevent name reuse from acquiring an old client's
permissions; generations distinguish executions of the same record.

## Operator connections

The operator API uses a local Unix socket. A configured program bridge runs as
the session user, independently of the program in tmux. Its connection limit is
explicit and bounded. Disconnecting a bridge leaves the terminal program alive.

The fixed environment bridge exposes unprivileged filesystem operations and
shell execution. It requires the exact record ID, execution generation, and
machine revision. File and directory handles live only for the connection, so a
reader continues to refer to its opened file across renames. The bridge owns no
agent runtime, conversation log, durable task journal, or model credentials.

A transient systemd unit contains a fixed operator supervisor, its unprivileged
file helper, and its commands. Filesystem requests go only to the file helper;
the supervisor drops each command to the session account. Each command
starts in its own root-owned control group. Cancellation kills that command's
processes; disconnection kills every command owned by the connection, including
children that create new process sessions. Stream chunks are bounded and apply
backpressure. Spill files preserve complete output when requested. The host
application decides whether an interrupted operation is safe to repeat.

Lifecycle changes close every bridge and wait for it to leave the old instance
before suspending, replacing, restoring, or deleting that execution. Transfer
and job creation hold the same per-session lifecycle claim while checking their
record and generation preconditions. If a bridge cannot acknowledge exit within
eight seconds, the lifecycle request fails and leaves the instance untouched;
the bridge remains tracked until the guest confirms cleanup.

## Immutable transfers and detached jobs

Operator uploads use SHA-256 content addresses and a 128 MiB limit. The fixed
guest helper installs root-owned, read-only blobs that the session user can
consume. Captures freeze a bounded regular file beneath `/work`, retain its
hash and bytes under root-owned storage, and replay the same capture ID without
recapturing a modified source. Symbolic-link escapes and special files are
rejected.

Detached jobs serve application provisioning, export, and independent
verification. A stable job ID binds one command, input digest, and machine
revision. The root-owned request receipt is committed before dispatch. Reusing
the ID returns its saved state; a changed payload conflicts. An interrupted
runner reports an unknown or failed outcome and is never silently rerun.
Commands run as the session user, with timeout and output bounds, in their own
systemd units. Application owners retain results before destroying instances.

## Repositories and authentication

Public repository mirrors are host caches. A session receives only its selected
repositories at recorded commits, under `/work/<owner>/<repo>`, then uses the real
remote. Retained commits survive upstream branch rewrites. Local or private
inputs can instead arrive as immutable blobs through the operator API.

Bay does not provision model credentials. An interactive terminal program can
sign in inside its instance. A host model harness can keep its own credentials
on the host and use only Bay's remote execution environment. Secrets do not
belong in session records, image declarations, or immutable input bundles.

## Guest gateway and network isolation

The guest reaches a separate, narrow gateway over vsock. Incus-derived caller
identity supplies the session record and execution generation; guests cannot
choose another sender. The gateway owns threaded mail and content-free ntfy
notifications. Its database keys participants by record ID, so removing and
reusing a name cannot reveal the old inbox. Host applications can observe the
forward mail feed without marking the operator's inbox read. Durable client IDs
bind message receipts before a recipient name is resolved again.

The gateway has no Incus access. Guests cannot reach the operator socket or
invoke privileged transfers and jobs through messaging. Incus ACLs, NIC port
isolation, address filtering, and project restrictions keep the host, private
networks, and other sessions outside guest network access.

## Validation

Go tests cover records, identities, lifecycle races, stream limits, message
receipts, immutable transfers, detached jobs, and filesystem/process behavior.
The Nix platform test runs real nested Incus VMs and checks isolation, mail,
multiple immutable machine revisions, pinned lifecycle behavior, unprivileged
execution, snapshots, suspension, and connection cleanup.

See [CONTEXT.md](../CONTEXT.md) for domain terms and [the ADRs](adr/) for the
ownership decisions behind the session store and gateway.
