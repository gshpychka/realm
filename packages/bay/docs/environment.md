# Operator execution and transfers

[Bay quickstart](../README.md) · [Design](design.md) · [Pituitary agents](../../../agents)

This API lets a host application use Bay for files, commands, and immutable transfers.
Bay owns execution; the application owns its tasks and conversations. The guest
receives no model credentials or agent runtime.

## Execution identity

The session's JSON description includes `id`, `generation`, `machine`, and
`machineRevision`. Fresh launches and explicit resumes advance the host-owned
generation, including snapshot restore. Applications pin all four values rather
than relying on a reusable session name.

## Files and commands

`POST /v1/sessions/NAME/environment` opens the fixed filesystem/shell adapter.
It requires `Bay-Session-ID`, `Bay-Session-Generation`, and
`Bay-Machine-Revision` headers and echoes them. This operator-only duplex
connection runs filesystem operations and commands as the session user,
independently of tmux. A fixed operator supervisor owns their transient systemd
unit and process lifetime. Opened file handles survive renames. Each command has its own root-owned
control group, so cancellation kills that command's descendants and disconnect
kills every command owned by the connection. Closing request input drains the
helper's final responses and cleanup acknowledgement. Frames are JSON lines,
bounded to 1 MiB, with base64 byte chunks of at most 64 KiB; the implementation
in [internal/environment](../internal/environment/) defines the small protocol.

## Immutable transfers and detached jobs

Machine input and retained results use separate operator routes, each requiring
record and generation headers:

| Route | Behavior |
| --- | --- |
| `PUT /v1/sessions/NAME/blobs/SHA256` | Upload immutable bytes, at most 128 MiB; returns their digest, size and guest path. |
| `POST /v1/sessions/NAME/captures/ID` | Freeze `{path,maxBytes}` under `/work`; replay returns the same captured bytes. |
| `GET /v1/sessions/NAME/captures/ID` | Download the frozen bytes with their SHA-256 header. |
| `POST /v1/sessions/NAME/jobs/ID` | Dispatch one bounded unprivileged detached command. |
| `GET /v1/sessions/NAME/jobs/ID` | Read the saved command identity, current output and terminal outcome. |

A detached command supplies `argv`, relative `cwd` (`.` is `/work`), `timeoutMs`,
`maxOutputBytes`, `machineRevision`, and an optional `inputDigest`. Timeout is
bounded to 30 minutes and combined output to 8 MiB. A job ID permanently binds
its payload in that execution. Retrying the same request never executes it
again; a different payload conflicts. An interrupted dispatch or runner reports
its uncertain outcome rather than retrying a command silently. Root-owned
receipts protect these application operations from the session user. The
connection-scoped environment itself keeps no durable tasks or agent state.

