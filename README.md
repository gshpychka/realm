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

## Layout

| Path | Contents |
| --- | --- |
| `machines/` | One directory per host |
| `agents/` | Dura roles, NixOS execution environments, and verification |
| `modules/common/` | Typed `my.*` globals: domain, user, SSH keys, build servers |
| `modules/system/` | NixOS and nix-darwin modules |
| `modules/home-manager/` | neovim, zsh, tmux, git, coding agents |
| `overlays/` `packages/` | Package overlays and custom packages |
| `secrets/` | sops-encrypted secrets |
| `infra/` | Terraform for GCP, Cloudflare and Tailscale; Alchemy stacks for Link Sanitizer and ProbaBench |
| `scripts/` | Runbooks for the travel router, Kodi box and Voice PE; OpenClaw's nixos-control plugin |
| `tests/` | NixOS VM tests and declarative module/catalog checks |

## Applications

| Start here | What you get | First step |
| --- | --- | --- |
| [Pituitary](packages/pituitary#start-a-conversation) | The terminal frontend for Pi and Dura | `nix run .#pituitary` |
| [Dura](packages/dura) | Durable agents, delegation, and independently verified results | `dura run --agent coordinator --workspace "$PWD" '…'` |
| [Bay](packages/bay#try-a-session) | An isolated NixOS session for a shell, editor, or coding agent | Enable the host, then `bay start scratch` |
| [Agents](agents) | A team that delegates, retains code, and verifies results | Import the starter team into `services.dura.agents` |

Pituitary presents conversations. Regular Pi runs interactive sessions; Dura runs
durable agents over Bay. [NixOS declarations](agents) describe their machines and roles.
Each folder opens with its own quickstart. Pituitary's guide includes a
[credential-free terminal demo](packages/pituitary#develop-without-rebuilding-the-system).

```sh
nix run .#pituitary
nix build .#bay .#flare                    # Linux
nix develop .#pituitary                   # then: bun install && cd packages/pituitary && just run tool
nix develop .#bay                         # then: cd packages/bay && go test ./...
```

The flake exports `homeManagerModules.pituitary` (`programs.pituitary`),
`nixosModules.dura` (`services.dura`), and `nixosModules.bay`
(`services.bay`). Realm imports these with its regular module trees; enabling a
service is a host decision in `machines/`. `lib.bayGuestImage` builds a standalone
Bay guest image. Bay, Dura, and Pituitary source, modules, and issues live in Realm.

[ProbaBench](infra/probabench) benchmarks how accurately language models follow
requested sampling probabilities. Its CLI, results notebook and Cloudflare
Alchemy deployment live under `infra/probabench`; use `nix develop .#infra` to
work on it.

Hoard also supports [Hermes Agent](machines/hoard/hermes-agent/README.md), with
its own service identity, Telegram bot, model login and persistent state.

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
