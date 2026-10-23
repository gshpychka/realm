# realm

## Overview
Personal Nix flake configuration for multiple machines (eve, harbor, reaper, hoard, buoy) plus a bootable installer ISO.

## Architecture
- `machines/` - Machine-specific configurations
- `modules/common/` - Shared options and values, including the typed `my.*` globals (domain, user, SSH keys, build servers) defined in `globals.nix`
- `modules/system/` - System-level modules, split into `common/`, `darwin/`, and `nixos/`
- `modules/home-manager/` - home-manager configs (neovim, zsh, tmux, git, and other user tooling)
- `overlays/` - Package overlays
- `packages/` - Application source and Nix packages: `pituitary/` (terminal frontend for regular Pi and Dura), `dura/` (Pi Durable harness and Bay connector), and `bay/` (Go module for isolated NixOS execution environments). Pituitary and Dura share the root Bun workspace.
- `agents/` - Dura role declarations and their NixOS execution environments
- `secrets/` - SOPS encrypted secrets
- `tests/` - NixOS VM tests and declarative module/catalog checks, exposed as flake checks
- `infra/` - Cloud infrastructure: Terraform units (GCP VM for buoy, Cloudflare DNS and tunnels), the bootstrap GCE image under `infra/nixos/`, and Alchemy stacks: `link-sanitizer/` (Telegram bot on AWS Lambda), `probabench/` (probability benchmark runner and static results site on an assets-only Cloudflare Worker at `probabench.<domain>`)
- `scripts/` - Artifacts for devices outside the flake, one folder per device with a `runbook.md` as its deployment path: `mudi/` (GL.iNet travel router), `kodi/` (CoreELEC Kodi box) and `voice-pe/` (kitchen Home Assistant Voice PE firmware)

## Standards
- As much as possible should be declarative
- Imperative steps should be recorded in comments close to where they are relevant
- Not too much abstraction and/or layers of indirection
- Type safety is important, magic strings should be avoided where possible
- Weird / non-obvious things should be explained clearly in comments
- Refactoring should not be feared
- Assumptions about functionality should be avoided, or at least documented explicitly
- Treat the code as fully greenfield. Describe and implement the steady state only: no legacy paths, backwards compatibility, migrations, or upgrade scaffolding.
- Prefer deleting code to preserving it. Use upstream capabilities directly; retain custom machinery only when the steady-state design needs it.
- Treat checks and builds as expensive. Batch validation at major milestones; use focused reruns only to resolve concrete failures.

## Machines
- eve: M2 Pro MacBook (aarch64-darwin)
    - Acts as the entry point - the only machine that is used directly
    - nix-darwin for system setup, homebrew for GUI apps
- harbor: Raspberry Pi 4 DNS/DHCP server (aarch64-linux)
    - dnsmasq for DHCP and local DNS, AdGuard Home for upstream ad blocking
- reaper: Desktop with Intel 14900k, RTX 4090, 96GB RAM (x86_64-linux)
    - Headless
    - AI server: ollama, whisper (speech-to-text), kokoro (text-to-speech); open-webui available
    - Distributed build server for the other machines (x86_64 natively, aarch64 via QEMU binfmt)
    - Work environment: SSH from eve, coding in neovim
- hoard: Beelink S12 Pro Intel N100 mini PC media server with external HDD enclosure (x86_64-linux)
    - Media server running the arr stack and Plex
- buoy: GCP Compute Engine VM / VPS (x86_64-linux)
    - Public status page (Gatus) exposed via Cloudflare Tunnel, Telegram alerting
    - Built as a GCE image and deployed with `nixos-rebuild switch --flake .#buoy --target-host buoy --sudo`
- iso: Bootable NixOS installer image (x86_64-linux)
    - Build with `nix build .#iso`; SSH into the booted installer via `ssh nixos@iso`

## Notes
- Pituitary, Dura, and Bay are maintained here. Public modules are `modules/home-manager/pituitary.nix`, `modules/system/nixos/dura.nix`, `packages/dura/agent-module.nix`, and `modules/system/nixos/bay.nix`.
- Use `nix develop .#pituitary`, `bun install` at the root, and `cd packages/pituitary && just live` to iterate on the frontend. `just dura attach RUN --watch` reloads only the Dura frontend. `just loop` runs Pituitary's full validation batch.
- Use `nix develop .#dura` for the harness. Bay's `nix build .#bay` runs its Go tests; `.#checks.x86_64-linux.bay-vm` exercises nested VMs and needs KVM.
- ProbaBench (`infra/probabench`) is worked on in `nix develop .#infra`: `bun run check` there runs its types, tests and production build, which `.#checks.x86_64-linux.probabench` repeats offline. After dependency changes, `bun install` regenerates `bun.nix`; commit it with `bun.lock`.
- Nix only sees files that are tracked by git - run `git add` after creating new files before checking config
- At a major configuration milestone, evaluate with `nix flake check --all-systems --no-build`; build the relevant packages and checks together.
