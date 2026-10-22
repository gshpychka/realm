# Bay

Disposable, isolated VM sessions for terminal programs, coding agents included, on one NixOS workstation. Bay lives in Realm; [docs/design.md](docs/design.md) holds the design and [CONTEXT.md](CONTEXT.md) the vocabulary.

## Host setup

Realm's [NixOS module](../../modules/system/nixos/bay.nix) sets up the host: Incus with the Bay project, the session image and its warm base, the Bay server and the session gateway. Realm imports the module for every NixOS host; enable it through `services.bay`. [Reaper's configuration](../../machines/reaper/bay.nix) supplies its programs and guest configuration.

```nix
{
  networking.hostId = "8425e349"; # ZFS needs one
  services.bay = {
    enable = true;
    operator = "alice";
    network.address = "10.80.0.1/24";
    programs.claude = {
      command = [ "claude" "--mcp-config" "/etc/bay/mcp.json" ];
      resume = [ "claude" "--continue" "--mcp-config" "/etc/bay/mcp.json" ];
      history = [ ".claude/projects" ];
    };
    guest.modules = [ ({ pkgs, ... }: { environment.systemPackages = [ pkgs.claude-code ]; }) ];
  };
}
```

`/etc/bay/mcp.json` in the session image declares the gateway's MCP server for agents that read that format.

`services.bay.machines` registers additional `{ metadata, disk, resources }` images;
`programs.<name>.machine` selects one. The default machine still comes from `guest.modules`.
Resources specify `cpus`, `memory`, and `disk`, with GiB for memory and disk; omitted
values follow `services.bay.sessions`. Equal images and allocations share an immutable
warm base. A session pins its machine revision and allocation, so changing the catalog
does not silently change an existing session. Bases from earlier revisions remain
available; automatic base/image garbage collection is not implemented.

`sessions.maxRunning` limits running and starting sessions. `sessions.maxMemory` also
limits their total pinned memory and defaults to `maxRunning * memory`. Suspended
sessions consume neither admission allowance. Pituitary's host module generates these
machine and program declarations from its named NixOS agents.

## Driving sessions

The operator runs `bay` on the host; `bay help` lists the commands. Inside a session, `flare` notifies the operator and sends and reads messages; `flare -h` lists its commands.

```sh
bay start review claude --repo gshpychka/realm@main
bay attach review                   # detach with tmux's Ctrl-B, D
bay suspend review                  # keeps the running program's memory
bay resume review
bay snap review before-refactor
bay end review                      # keeps the record and program history
bay start review                    # fresh instance from that record
```

`end` discards the instance's disk, including unpushed commits and uncommitted files. Push work before ending, or suspend to keep it. Repositories restart at the revision recorded when the session was created; Bay retains that revision in its mirror even if its branch is later deleted or force-pushed. Credential delivery is still planned: repository mirrors currently fetch public GitHub repos without host credentials; sign in to programs inside each fresh instance.

`rm` removes the instance, record and saved history. The host's shared repository mirrors and their retained revisions remain as a cache; Bay currently has no automatic cache eviction.

Programs can also provide a persistent machine endpoint through an optional `connect = [ "worker" "connect" ];` command. Bay runs that predefined bridge as the session user, separately from the program in tmux. `bay show NAME --json` returns the session's stable `id` and `capabilities.connect`; use `bay connect NAME --id ID` to connect stdin/stdout. Disconnecting closes the bridge and leaves the program running. `maxConnections` bounds simultaneous bridges and defaults to one; the program owns its input-control policy. Suspend, rollback, end and removal disconnect bridges before changing the instance.

The operator-only HTTP equivalent is `POST /v1/sessions/NAME/connect` over `/run/bay/bay.sock`, with the required `Bay-Session-ID: ID` header. It streams request and response bytes concurrently as `application/octet-stream`, echoes the session ID, and applies backpressure without buffering a conversation. A missing ID is a 400; a stale ID, unsupported program, non-running session or exhausted connection allowance is a 409. A 200 accepts the bridge; the program's own handshake establishes readiness. A bridge failure after headers sets the `Bay-Connection-Error: bridge-failed` response trailer. The protocol inside those bytes belongs to the program, and closing request input still allows its final response to drain. The ID survives session restarts but changes when a removed name is reused.

`bay send review 'please review the diff'` starts a message thread; `bay read THREAD` reads it. Inside a session, use `flare send operator 'ready to review'`, `flare inbox`, and `flare read THREAD`. Both send commands accept piped input (up to 64 KiB). Reads return the newest messages within a 256 KiB page; when older messages remain, the output gives a `read THREAD --before MESSAGE` command to fetch the preceding page. Only messages returned on that page are marked read. Agents use the same `before` cursor in the gateway's `read_thread` MCP tool.

## Development

Run these commands from Realm's root:

- `nix develop .#bay` provides Go, gopls and the Nix tooling. Run `cd packages/bay && go test ./...` inside the shell to test the Go module directly.
- `nix build .#bay .#flare` builds the host binaries and the guest command. The Bay build runs all Go tests, including tests for `flare`.
- `nix run .#bay -- help` and `nix run .#flare -- -h` list their commands.
- `nix fmt` formats Realm, including Bay's Go and shell sources. `nix flake check` runs the repository's shared formatting and lint checks.
- `nix build .#checks.x86_64-linux.bay-vm` runs the [platform test](../../tests/bay.nix): a host VM running real session VMs, which needs KVM with nested virtualisation.

[default.nix](default.nix) packages the Go module; its source includes only `go.mod`, `go.sum`, `cmd` and `internal`. [image.nix](image.nix) evaluates [guest.nix](guest.nix) separately from the host modules and uses the host's Bay package for `flare`.

The source was migrated from [`gshpychka/bay` at `2c0ae33`](https://github.com/gshpychka/bay/commit/2c0ae338b3324e081331b42cdfb9345f05f2d02b). The standalone repository is retired; development and issues belong in Realm.
