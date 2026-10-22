# realm

## Overview
Personal Nix flake configuration for multiple machines (eve, harbor, reaper, hoard, buoy) plus a bootable installer ISO.

## Architecture
- `machines/` - Machine-specific configurations
- `modules/common/` - Shared options and values, including the typed `my.*` globals (domain, user, SSH keys, build servers) defined in `globals.nix`
- `modules/system/` - System-level modules, split into `common/`, `darwin/`, and `nixos/`
- `modules/home-manager/` - home-manager configs (neovim, zsh, tmux, git, and other user tooling)
- `overlays/` - Package overlays
- `packages/` - Custom package definitions and application source: `pituitary/` (Bun workspace for the pi frontend) and `bay/` (Go module for isolated VM sessions, including its guest image)
- `secrets/` - SOPS encrypted secrets
- `tests/` - NixOS VM tests, exposed as flake checks
- `infra/` - Cloud infrastructure: Terraform units (GCP VM for buoy, Cloudflare DNS and tunnels), the bootstrap GCE image under `infra/nixos/`, and the `link-sanitizer/` Alchemy stack (Telegram bot on AWS Lambda)
- `scripts/` - Artifacts for devices outside the flake, one folder per device with a `runbook.md` as its deployment path: `mudi/` (GL.iNet travel router), `kodi/` (CoreELEC Kodi box) and `voice-pe/` (kitchen Home Assistant Voice PE firmware)

## Standards
- As much as possible should be declarative
- Imperative steps should be recorded in comments close to where they are relevant
- Not too much abstraction and/or layers of indirection
- Type safety is important, magic strings should be avoided where possible
- Weird / non-obvious things should be explained clearly in comments
- Refactoring should not be feared
- Assumptions about functionality should be avoided, or at least documented explicitly

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
- Pituitary and Bay are maintained here; do not restore their former flake inputs. Their public modules are `modules/home-manager/pituitary.nix` and `modules/system/nixos/bay.nix`.
- Use `nix develop .#pituitary` and `cd packages/pituitary && just loop` for its complete development loop. Bay's `nix build .#bay` runs its Go tests; `.#checks.x86_64-linux.bay-vm` exercises nested VMs and needs KVM.
- Nix only sees files that are tracked by git - run `git add` after creating new files before checking config
- Check config after making non-trivial changes: `nix flake check --all-systems --no-build`
- Perform a full build if on the relevant machine: `nix flake check`
