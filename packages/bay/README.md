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

## Driving sessions

The operator runs `bay` on the host; `bay help` lists the commands. Inside a session, `flare` notifies the operator and sends and reads messages; `flare -h` lists its commands.

## Development

Run these commands from Realm's root:

- `nix develop .#bay` provides Go, gopls and the Nix tooling. Run `cd packages/bay && go test ./...` inside the shell to test the Go module directly.
- `nix build .#bay .#flare` builds the host binaries and the guest command. The Bay build runs all Go tests, including tests for `flare`.
- `nix run .#bay -- help` and `nix run .#flare -- -h` list their commands.
- `nix fmt` formats Realm, including Bay's Go and shell sources. `nix flake check` runs the repository's shared formatting and lint checks.
- `nix build .#checks.x86_64-linux.bay-vm` runs the [platform test](../../tests/bay.nix): a host VM running real session VMs, which needs KVM with nested virtualisation.

[default.nix](default.nix) packages the Go module; its source includes only `go.mod`, `go.sum`, `cmd` and `internal`. [image.nix](image.nix) evaluates [guest.nix](guest.nix) separately from the host modules and uses the host's Bay package for `flare`.

The source was migrated from [`gshpychka/bay` at `2c0ae33`](https://github.com/gshpychka/bay/commit/2c0ae338b3324e081331b42cdfb9345f05f2d02b). The standalone repository is retired; development and issues belong in Realm.
