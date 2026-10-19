<img src=".github/readme/logo.svg" height="72" alt="realm">

One Nix flake for every machine I run: NixOS, nix-darwin and home-manager, with secrets in sops.

[![check](https://img.shields.io/github/actions/workflow/status/gshpychka/realm/check.yml?branch=main&label=check&labelColor=3c3836)](https://github.com/gshpychka/realm/actions/workflows/check.yml)

## Fleet

<p align="center">
  <a href="machines/eve"><img src=".github/readme/eve.svg" width="32%" alt="eve: M2 Pro MacBook, aarch64-darwin"></a>
  <a href="machines/reaper"><img src=".github/readme/reaper.svg" width="32%" alt="reaper: i9-14900K, RTX 4090, 96 GB, x86_64-linux"></a>
  <a href="machines/hoard"><img src=".github/readme/hoard.svg" width="32%" alt="hoard: Beelink S12 Pro, N100, x86_64-linux"></a>
  <br>
  <a href="machines/harbor"><img src=".github/readme/harbor.svg" width="32%" alt="harbor: Raspberry Pi 4, aarch64-linux"></a>
  <a href="machines/buoy"><img src=".github/readme/buoy.svg" width="32%" alt="buoy: GCP Compute Engine VM, x86_64-linux"></a>
  <a href="machines/iso"><img src=".github/readme/iso.svg" width="32%" alt="iso: bootable installer image, x86_64-linux"></a>
</p>

The proposed Raspberry Pi 5 [Home Assistant configuration](machines/home-assistant)
has a [migration and rollback runbook](scripts/home-assistant/runbook.md), coverage
maps and scoped build checks. Installation and activation require a separate
authorized state handover; this branch does not change the running HAOS host.

## Layout

| Path | Contents |
| --- | --- |
| `machines/` | One directory per host |
| `modules/common/` | Typed `my.*` globals: domain, user, SSH keys, build servers |
| `modules/system/` | NixOS and nix-darwin modules |
| `modules/home-manager/` | neovim, zsh, tmux, git, coding agents |
| `overlays/` `packages/` | Package overlays and custom packages |
| `secrets/` | sops-encrypted secrets |
| `infra/` | Terraform for GCP, Cloudflare and Tailscale; the link-sanitizer Telegram bot |
| `scripts/` | Runbooks for the travel router, Kodi box and Voice PE; OpenClaw's nixos-control plugin |
| `tests/` | NixOS VM tests |

## Usage

```sh
# apply on the current machine
nh os switch
nh darwin switch

# deploy buoy
nixos-rebuild switch --flake .#buoy --target-host buoy --sudo

# build the installer and harbor's SD image
nix build .#iso
nix build .#harbor-sd-image

# evaluate every system
nix flake check --all-systems --no-build
```
