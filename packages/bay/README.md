# Bay

**A session you can leave running. A machine you can throw away.**

Run a shell, editor, or coding agent in an isolated NixOS session. Detach and come
back later, suspend its memory, or take a snapshot before an experiment. Each
session gets its own files and running program.

[Try a session](#try-a-session) · [Set up a host](#set-up-a-host) ·
[Keep or discard work](#keep-or-discard-work) · [Pituitary](../pituitary) · [Agents](../../agents)

| Use Bay directly when… | Use [Dura agents](../../agents) when… |
| --- | --- |
| You want a shell or terminal application in its own VM | You want work delegated across declared roles |
| The program manages its own conversation and login | Models and credentials should stay on the host |
| You manage Git commits and result delivery | You want retained code, integration, and independent verification |

## Try a session

**Prerequisite:** a [configured NixOS host](#set-up-a-host) with Bay enabled and its
warm base ready. Run these commands as its configured operator. Building the CLI
alone does not create the host services.

```sh
bay start scratch
bay attach scratch
```

You are in the session's shell, with its workspace under `/work`. Try a command or
edit a file. Detach with tmux's `ctrl+b`, then `d`. The program keeps running.

Back on the host:

```sh
bay list
bay show scratch
bay suspend scratch
bay resume scratch
bay attach scratch
```

Suspend keeps disk and memory. Resume returns to the same workspace. To start with
a public GitHub repository:

```sh
bay start review --repo gshpychka/realm@main
bay attach review
```

Repositories are checked out at `/work/OWNER/NAME`. Repeat `--repo` to add more;
selected revisions are pinned when the session is created.

## Set up a host

Bay needs NixOS, hardware virtualization through KVM, an existing operator account,
and storage for its ZFS-backed sessions. It can create a ZFS pool in a loop file,
so an existing ZFS installation is not required. Choose a bridge subnet that does
not overlap your networks and preserve your host's existing `networking.hostId`.

In a NixOS module:

```nix
{ inputs, ... }:
{
  imports = [ inputs.realm.nixosModules.bay ];

  networking.hostId = "8425e349"; # example; use your host's stable eight-hex-digit ID
  services.bay = {
    enable = true;
    operator = "alice"; # an existing account
    network.address = "10.80.0.1/24";
  };
}
```

Realm already imports the module. Add host settings to its `machines/` module and
apply the NixOS configuration through your normal deployment workflow. The
[module](../../modules/system/nixos/bay.nix) sets up Incus, the Bay project, network
isolation, image, warm base, server, and messaging gateway. Allow the initial image
and warm base to finish preparing:

```sh
systemctl status bay-base bay-server bay-gateway-operator.socket
bay list
```

`bay list` should succeed even before any sessions exist. For startup diagnostics,
use `journalctl -u bay-base -u bay-server -u bay-gateway`. The messaging gateway is
socket-activated; its service can remain inactive until the first message.

The defaults allocate a 200 GiB loop-backed pool. Sessions get 4 vCPUs, 8 GiB memory,
and a 50 GiB disk; saved memory and snapshots need storage too. Adjust `storage` and
`sessions` to fit your host. Bay requires `networking.nftables.flushRuleset = false`
so firewall reloads preserve Incus rules.

## Give a session a program

Declare programs and their guest dependencies together. For example, add Claude Code
to your Bay configuration:

```nix
{
  services.bay = {
    programs.claude = {
      command = [ "claude" "--mcp-config" "/etc/bay/mcp.json" ];
      resume = [ "claude" "--continue" "--mcp-config" "/etc/bay/mcp.json" ];
      history = [ ".claude/projects" ];
    };
    guest.modules = [
      ({ pkgs, ... }: {
        environment.systemPackages = [ pkgs.claude-code ];
      })
    ];
  };
}
```

After applying that configuration:

```sh
bay start coding claude --repo gshpychka/realm@main
bay attach coding
```

Sign in inside the fresh session. Host credentials are not copied into guests.
`/etc/bay/mcp.json` exposes the gateway to programs that read that MCP configuration
format. History paths retain conversation data, never credential files.

For a one-off command, use `bay start NAME -- COMMAND…`; install the executable in
the guest first. `bay help` and `bay help COMMAND` list commands.
[Reaper's module](../../machines/reaper/bay.nix) includes hooks and notifications;
its `my.bay.enable` switch is off by default.

## Keep or discard work

| Action | Command | What stays |
| --- | --- | --- |
| Leave the terminal | tmux `ctrl+b`, then `d` | Running program, memory, and disk |
| Pause | `bay suspend review` | Memory and disk, ready to resume |
| Save an experiment point | `bay snap review before-refactor` | A named copy of disk and memory |
| Restore that point | `bay resume review --snapshot before-refactor` | The snapshot's state; later snapshots are removed |
| End | `bay end review` | Session record and declared program history |
| Start fresh again | `bay start review` | A fresh instance from the pinned record |
| Remove | `bay rm review` | No session record, instance, or saved program history |

**Before `end`, push or export work you want to keep.** Ending deletes the instance's
disk and snapshots, including unpushed commits and uncommitted files. Suspend to
return to the exact workspace. Snapshot rollback discards newer workspace changes.
The CLI asks before destructive operations when needed.

An ended session restarts repositories at their recorded revisions and restores
configured program history. Public GitHub mirrors retain those revisions even if
the remote branch is deleted or rewritten; they fetch without host credentials.

<details>
<summary>Repository cache lifetime</summary>

Removing a session leaves shared repository mirrors as a cache, with no automatic
eviction. Branches and tags follow the remote; explicit commit IDs can select
cached history. Sessions receiving the same repository receive its cached history,
including retained commits. Deleting or rewriting a remote branch does not purge
those local copies.

</details>

## Send a message

On the host, address the session by name:

```sh
bay send review 'Please review the diff'
bay threads
```

Inside the session:

```sh
flare inbox
flare send operator 'Ready for your review'
```

Use the returned thread ID with `bay read THREAD` on the host or `flare read THREAD`
in the session. Both send commands accept piped input up to 64 KiB. Reads return
the newest messages within a 256 KiB page and give a `read THREAD --before MESSAGE`
command when earlier messages remain. Only returned messages are marked read. The
`read_thread` MCP tool uses the same cursor. `flare -h` lists guest commands.

Bay mail is for terminal programs and the operator. Dura teams collaborate
through their native durable conversations.

## Declare more environments

`services.bay.machines` registers `{ metadata, disk, resources }` images;
`programs.<name>.machine` selects one. The default comes from `guest.modules`.
Resources specify `cpus`, `memory`, and `disk`, with GiB for memory and disk;
omitted values follow `services.bay.sessions`.

Equal images and allocations share an immutable warm base. Sessions pin their
machine revision and allocation. `sessions.maxRunning` limits running and starting
sessions; `sessions.maxMemory` limits their total pinned memory and defaults to
`maxRunning * memory`. Suspended sessions consume neither allowance. At startup,
Bay removes old bases and images once no catalog or session record references them.

[Dura’s module](../../modules/system/nixos/dura.nix) generates these
machine and program declarations from [NixOS agent modules](../../agents).
Applications can use Bay's [execution and transfer API](docs/environment.md)
without installing an agent runtime in the guest.

## Work on Bay

From Realm's root:

```sh
nix develop .#bay
cd packages/bay
go test ./...
```

`nix build .#bay .#flare` builds host binaries and the guest command; Bay's package
build runs all Go tests, including Flare's. `nix run .#bay -- help` and
`nix run .#flare -- -h` work without enabling services. `nix fmt` covers Bay's Go
and shell sources. Batch checks at a meaningful milestone.

The [platform test](../../tests/bay.nix), built with
`nix build .#checks.x86_64-linux.bay-vm`, boots a host running real session VMs and
needs KVM with nested virtualization. The [design](docs/design.md),
[vocabulary](CONTEXT.md), and [execution API](docs/environment.md) explain the
boundaries. [default.nix](default.nix) packages the Go module;
[image.nix](image.nix) evaluates [guest.nix](guest.nix) separately from the host.

Bay source, packages, modules, and issues are maintained in Realm.
