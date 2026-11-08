<img src=".github/readme/logo.svg" height="72" alt="realm">

One Nix flake for every machine I run, the cloud around them, and the tools I build on them: NixOS, nix-darwin and home-manager, with secrets in sops.

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

| Device | Role | Configuration |
| --- | --- | --- |
| eve | Daily laptop and the entry point to everything else | [`machines/eve`](machines/eve) |
| reaper | Headless workstation: local AI, fleet build server, host for Bay and Dura | [`machines/reaper`](machines/reaper) |
| hoard | Media server and home assistants | [`machines/hoard`](machines/hoard) |
| harbor | LAN DNS and DHCP with ad blocking | [`machines/harbor`](machines/harbor) |
| buoy | Public status page and alerting | [`machines/buoy`](machines/buoy) |
| Kodi box | CoreELEC media player | [`scripts/kodi`](scripts/kodi/runbook.md) |
| Mudi | GL.iNet travel router | [`scripts/mudi`](scripts/mudi/runbook.md) |
| Voice PE | Home Assistant voice speakers | [`scripts/voice-pe`](scripts/voice-pe/runbook.md) |

## Applications

| Application | Contents |
| --- | --- |
| [Pituitary](packages/pituitary) | Terminal frontend for Pi and Dura |
| [Dura](packages/dura) | Durable agent harness with independent verification |
| [Bay](packages/bay) | Isolated NixOS execution environments |
| [Agents](agents) | Dura roles and their execution environments |
| [Voice broker](packages/voice-broker) | Bridge between the Voice PE speakers and the home assistants |
| [rolesanywhere](packages/rolesanywhere) | AWS credentials from a TPM-held CA |
| [ProbaBench](infra/probabench) | Benchmark of how well language models follow requested probabilities |
| [Link Sanitizer](infra/link-sanitizer) | Telegram bot that strips tracking from links |

## Infrastructure

| Unit | Contents |
| --- | --- |
| [`infra/buoy`](infra/buoy) | GCP VM, network and tunnel for buoy |
| [`infra/dns`](infra/dns) | Cloudflare DNS records |
| [`infra/tailscale`](infra/tailscale) | Tailnet ACLs, devices and DNS |
| [`infra/aws`](infra/aws) | Roles Anywhere trust anchor and deploy role |
| [`infra/nixos`](infra/nixos) | Bootstrap GCE image |
| [`infra/bootstrap`](infra/bootstrap) | Terraform state backend |

## Layout

| Path | Contents |
| --- | --- |
| [`machines/`](machines) | One directory per host |
| [`modules/common/`](modules/common) | Typed `my.*` globals |
| [`modules/system/`](modules/system) | NixOS and nix-darwin modules |
| [`modules/home-manager/`](modules/home-manager) | User environment: neovim, zsh, tmux, git, coding agents |
| [`packages/`](packages) | Applications and custom packages |
| [`agents/`](agents) | Dura agent declarations |
| [`overlays/`](overlays) | Package overlays |
| [`secrets/`](secrets) | sops-encrypted secrets |
| [`infra/`](infra) | Terraform units and Alchemy stacks |
| [`scripts/`](scripts) | Imperative scripts and runbooks |
| [`tests/`](tests) | NixOS VM tests and module checks |

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
