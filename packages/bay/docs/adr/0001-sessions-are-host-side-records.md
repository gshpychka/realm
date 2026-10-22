# Sessions are host-side records, and instances are disposable

A session is kept as a record on the host: its program, the repos it can access and the commit each has checked out, the credentials it gets, and the program's history. Ending a session saves the record and deletes its Incus instance; starting it again boots a fresh instance from the current warm base and launches the program in its resume mode. Suspend sits alongside for returning to the exact running state, since it saves the instance's disk and memory.

## Considered Options

- **The stopped VM as the ended session**: the least machinery, but a restarted session keeps running the image it was created with, and every ended session holds its disk.
- **A per-session volume that outlives the VM**: every session runs in Incus stateful mode so it survives reboots, and on a local pool stateful mode accepts only extra disks that are deleted with their instance.

## Consequences

- Snapshots belong to the instance, so ending a session deletes them.
- The record names a session's credentials, the operator supplies them at every start, and saved history holds no credential files.
