{
  description = "My Machines";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    # source for reaper's whisper CUDA closure (cache.nixos-cuda.org builds these
    # on the 25.11 channel; see machines/reaper/whisper.nix), and an escape hatch
    # for packages broken on unstable
    nixos-stable.url = "github:nixos/nixpkgs/nixos-25.11";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    darwin = {
      url = "github:nix-darwin/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-homebrew = {
      # has no nixpkgs input, so there is nothing to `follows`
      url = "github:zhaofengli/nix-homebrew";
    };
    homebrew-core = {
      url = "github:homebrew/homebrew-core";
      flake = false;
    };
    homebrew-cask = {
      url = "github:homebrew/homebrew-cask";
      flake = false;
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    mcp-servers-nix = {
      url = "github:natsukium/mcp-servers-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    llm-agents = {
      # not following our nixpkgs: more cache hits that way
      url = "github:numtide/llm-agents.nix";
    };
    nix-openclaw = {
      # not following our nixpkgs: its pinned pnpm dependency hashes are
      # computed against its own nixpkgs
      url = "github:gshpychka/nix-openclaw/d40c8dc372056369cf5776d61f33a014803dc610";
      inputs.home-manager.follows = "home-manager";
    };
    nixified-ai = {
      url = "github:nixified-ai/flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    jovian-nixos = {
      url = "github:Jovian-Experiments/Jovian-NixOS";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware = {
      url = "github:NixOS/nixos-hardware/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # bun.nix's schema varies between versions, so the infra shell's CLI that
    # writes it and the checks' fetcher that reads it share this input; pinned
    # to the head of nix-community/bun2nix#110, which accepts the lockfile
    # versions 2 and 3 that bun 1.3+ writes
    bun2nix = {
      url = "github:nix-community/bun2nix/0456acb1b7394fc14c414b056aa889df5124943a";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # auto-imports a directory tree of modules
    import-tree.url = "github:vic/import-tree";
  };

  outputs =
    {
      self,
      nixpkgs,
      darwin,
      home-manager,
      nix-homebrew,
      ...
    }@inputs:
    let
      inherit (nixpkgs) lib;
      # Every platform supported by the fleet's nixpkgs toolchain.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      # formatter packages shared by `nix fmt` and the treefmt check
      treefmtTools =
        pkgs: with pkgs; [
          treefmt
          nixfmt
          stylua
          shfmt
          taplo
          ruff
          biome
          go
        ];
      projectPackages = lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bay = pkgs.callPackage ./packages/bay { };
        in
        {
          pituitary = pkgs.callPackage ./packages/pituitary { };
          dura = pkgs.callPackage ./packages/dura { };
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          inherit bay;
          inherit (bay) flare;
          rolesanywhere = pkgs.callPackage ./packages/rolesanywhere { };
        }
      );
    in
    {
      darwinConfigurations.eve = darwin.lib.darwinSystem {
        specialArgs = { inherit inputs; };
        modules = [
          inputs.sops-nix.darwinModules.sops
          home-manager.darwinModules.home-manager
          nix-homebrew.darwinModules.nix-homebrew

          ./modules/system/darwin
          ./machines/eve
        ];
      };

      nixosConfigurations.harbor = nixpkgs.lib.nixosSystem {
        specialArgs = { inherit inputs; };
        modules = [
          inputs.sops-nix.nixosModules.sops
          inputs.nixos-hardware.nixosModules.raspberry-pi-4
          home-manager.nixosModules.home-manager

          ./modules/system/nixos
          ./machines/harbor
        ];
      };

      nixosConfigurations.reaper = nixpkgs.lib.nixosSystem {
        specialArgs = { inherit inputs; };
        modules = [
          inputs.sops-nix.nixosModules.sops
          inputs.lanzaboote.nixosModules.lanzaboote
          inputs.jovian-nixos.nixosModules.jovian
          home-manager.nixosModules.home-manager

          ./modules/system/nixos
          ./machines/reaper
        ];
      };

      nixosConfigurations.hoard = nixpkgs.lib.nixosSystem {
        specialArgs = { inherit inputs; };
        modules = [
          inputs.sops-nix.nixosModules.sops
          home-manager.nixosModules.home-manager

          ./modules/system/nixos
          ./machines/hoard
        ];
      };

      # vm in gcp
      # nixos-rebuild switch --flake .#buoy --target-host buoy --sudo
      nixosConfigurations.buoy = nixpkgs.lib.nixosSystem {
        specialArgs = { inherit inputs; };
        modules = [
          inputs.sops-nix.nixosModules.sops

          ./modules/system/nixos
          ./machines/buoy
        ];
      };

      # bootable ISO installer image
      nixosConfigurations.iso = nixpkgs.lib.nixosSystem {
        specialArgs = { inherit inputs; };
        modules = [
          # sops-nix is needed for evaluation: the (disabled) modules in
          # modules/system/nixos define sops.secrets values behind mkIf
          inputs.sops-nix.nixosModules.sops

          ./modules/system/nixos
          ./machines/iso
        ];
      };

      packages = lib.recursiveUpdate projectPackages {
        x86_64-linux = {
          iso = self.nixosConfigurations.iso.config.system.build.isoImage;
          voice-pe-firmware = import ./scripts/voice-pe/firmware.nix {
            pkgs = nixpkgs.legacyPackages.x86_64-linux;
          };
          gce-image =
            let
              pkgs = nixpkgs.legacyPackages.x86_64-linux;
              original = self.nixosConfigurations.buoy-bootstrap.config.system.build.googleComputeImage;
            in
            pkgs.runCommand "gce-image.raw.tar.gz" { inherit original; } ''
              cp $original/*.raw.tar.gz $out
            '';
        };
        aarch64-linux.harbor-sd-image =
          (self.nixosConfigurations.harbor.extendModules {
            modules = [
              "${nixpkgs}/nixos/modules/installer/sd-card/sd-image-aarch64.nix"
              # harbor's root is ext4; the image does not need ZFS imports
              { boot.zfs.forceImportRoot = false; }
            ];
          }).config.system.build.sdImage;
      };

      homeManagerModules.pituitary = ./modules/home-manager/pituitary.nix;
      nixosModules.bay = ./modules/system/nixos/bay.nix;
      nixosModules.dura = ./modules/system/nixos/dura.nix;
      nixosModules.duraAgent = ./packages/dura/agent-module.nix;
      lib.bayGuestImage = import ./packages/bay/image.nix;
      lib.duraAgent = import ./packages/dura/agent.nix;

      # Minimal bootstrap NixOS config for GCE image
      # Full config is deployed separately via nixos-rebuild
      nixosConfigurations.buoy-bootstrap = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [ ./infra/nixos/configuration.nix ];
      };

      # One check per machine, grouped by system and derived from the config
      # sets, so new machines are covered automatically.
      checks =
        let
          # iso's build artifact is the ISO image, special-cased below;
          # buoy-bootstrap is only an image-build shim, covered by packages.gce-image
          machines = removeAttrs self.nixosConfigurations [
            "iso"
            "buoy-bootstrap"
          ];
          nixosChecks = lib.foldlAttrs (
            acc: name: machine:
            lib.recursiveUpdate acc {
              ${machine.config.nixpkgs.hostPlatform.system}.${name} = machine.config.system.build.toplevel;
            }
          ) { } machines;
          # statix + deadnix lint the flake source per system; statix.toml at the
          # repo root disables repeated_keys, deadnix runs strict on all but generated files
          lintChecks = lib.genAttrs systems (
            system:
            let
              pkgs = nixpkgs.legacyPackages.${system};
              piExtensionTypes = pkgs.callPackage ./packages/pi-extension-types.nix { };
              bun2nix = inputs.bun2nix.packages.${system}.default;
              # runs a Bun project's `bun run check` offline against its bun.nix
              bunCheck =
                {
                  src,
                  nativeBuildInputs ? [ ],
                }:
                pkgs.stdenvNoCC.mkDerivation {
                  name = "check-${baseNameOf src}";
                  inherit src;
                  bunDeps = bun2nix.fetchBunDeps {
                    bunNix = src + "/bun.nix";
                    # the hook drops patchedDependencies before bun install, so the cache carries the patches
                    overrides = bun2nix.patchedDependenciesToOverrides {
                      patchedDependencies =
                        lib.mapAttrs (_: patch: src + "/${patch}")
                          (lib.importJSON (src + "/package.json")).patchedDependencies;
                    };
                  };
                  nativeBuildInputs = [ bun2nix.hook ] ++ nativeBuildInputs;
                  buildPhase = "bun run check";
                  installPhase = "touch $out";
                };
            in
            {
              pituitary-home-manager = import ./tests/pituitary-home-manager.nix {
                inherit pkgs home-manager;
              };
              statix = pkgs.runCommand "check-statix" { nativeBuildInputs = [ pkgs.statix ]; } ''
                statix check ${self} -c ${self}
                touch $out
              '';
              deadnix = pkgs.runCommand "check-deadnix" { nativeBuildInputs = [ pkgs.deadnix ]; } ''
                deadnix --fail --exclude ${self}/infra/*/bun.nix -- ${self}
                touch $out
              '';
              # whole-tree format check; copy out of the read-only store so
              # treefmt can rewrite in place, then fail if anything changed
              treefmt = pkgs.runCommand "check-treefmt" { nativeBuildInputs = treefmtTools pkgs; } ''
                cp -r --no-preserve=mode,ownership ${self} src
                cd src
                HOME=$TMPDIR treefmt --no-cache --fail-on-change --tree-root .
                touch $out
              '';
              ruff = pkgs.runCommand "check-ruff" { nativeBuildInputs = [ pkgs.ruff ]; } ''
                cd ${self}
                ruff check --no-cache --config ruff.toml .
                touch $out
              '';
              # Treefmt owns formatting; Biome checks lint and import organization.
              # The store copy has no .git for Biome to read ignores from.
              biome = pkgs.runCommand "check-biome" { nativeBuildInputs = [ pkgs.biome ]; } ''
                biome check --formatter-enabled=false --config-path ${self}/biome.json --vcs-enabled=false ${self}
                touch $out
              '';
              # pi extensions typecheck against the vendored API declarations
              pi-extensions =
                pkgs.runCommand "check-pi-extensions" { nativeBuildInputs = [ pkgs.typescript ]; }
                  ''
                    cp -r --no-preserve=mode,ownership ${self}/modules/home-manager/pi/config src
                    ln -s ${piExtensionTypes} src/node_modules
                    tsc -p src/tsconfig.json
                    touch $out
                  '';
              link-sanitizer = bunCheck { src = ./infra/link-sanitizer; };
              probabench = bunCheck {
                src = ./infra/probabench;
                # vite, vitest and tsc run on Node, as in the infra shell
                nativeBuildInputs = [ pkgs.nodejs ];
              };
              # the Voice PE component's ESP-free logic, built for the host
              voice-pe = pkgs.runCommandCC "check-voice-pe" { buildInputs = [ pkgs.gtest ]; } ''
                $CXX -std=c++20 -Wall -Wextra -Werror -I${./scripts/voice-pe/components/voice_broker} \
                  ${./scripts/voice-pe/components/voice_broker/session.cpp} ${./scripts/voice-pe/tests}/*.cpp \
                  -lgtest_main -lgtest -o test
                ./test
                touch $out
              '';
            }
          );
        in
        lib.recursiveUpdate (lib.recursiveUpdate nixosChecks lintChecks) {
          aarch64-darwin.eve = self.darwinConfigurations.eve.config.system.build.toplevel;
          x86_64-linux =
            let
              pkgs = nixpkgs.legacyPackages.x86_64-linux;
              hoard = self.nixosConfigurations.hoard.config.system.build;
            in
            {
              inherit (projectPackages.x86_64-linux) bay flare rolesanywhere;
              dura-agents = import ./tests/dura-agents.nix { inherit pkgs; };
              dura-catalog = import ./tests/dura-catalog.nix { inherit pkgs; };
              bay-vm = import ./tests/bay.nix { inherit inputs pkgs; };
              bay-shellcheck =
                pkgs.runCommand "check-bay-shellcheck" { nativeBuildInputs = [ pkgs.shellcheck ]; }
                  ''
                    shellcheck --shell=bash ${./packages/bay/bay-session.sh}
                    touch $out
                  '';
              voice-broker = pkgs.callPackage ./packages/voice-broker { };
              rolesanywhere-vm = import ./tests/rolesanywhere.nix { inherit pkgs; };
              arr-sync = hoard.arrSync;
              tautulli = hoard.tautulliConfig;
              kodi = pkgs.runCommand "check-kodi" { nativeBuildInputs = [ pkgs.python3 ]; } ''
                cd ${self}
                python3 -m unittest discover -s tests -p 'test_kodi_*.py'
                touch $out
              '';
              iso = self.nixosConfigurations.iso.config.system.build.isoImage;
              nixos-switch = import ./tests/nixos-switch.nix { inherit inputs pkgs; };
            };
        };

      # `nix fmt` — treefmt drives the per-language formatters (see treefmt.toml)
      formatter = lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.writeShellApplication {
          name = "treefmt";
          runtimeInputs = treefmtTools pkgs;
          text = ''exec treefmt "$@"'';
        }
      );

      apps = lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          piPackages = pkgs.callPackage ./packages/pi-packages { };
          flashVoicePe = pkgs.callPackage ./scripts/voice-pe/flash.nix { };
          provisionVoicePe = pkgs.callPackage ./scripts/voice-pe/provision.nix { };
        in
        {
          pituitary = {
            type = "app";
            program = lib.getExe projectPackages.${system}.pituitary;
            inherit (projectPackages.${system}.pituitary) meta;
          };
          dura = {
            type = "app";
            program = lib.getExe projectPackages.${system}.dura;
            inherit (projectPackages.${system}.dura) meta;
          };
          update-pi-packages = {
            type = "app";
            program = lib.getExe piPackages.updateScript;
            inherit (piPackages.updateScript) meta;
          };
          provision-voice-pe = {
            type = "app";
            program = lib.getExe provisionVoicePe;
            inherit (provisionVoicePe) meta;
          };
          flash-voice-pe = {
            type = "app";
            program = lib.getExe flashVoicePe;
            inherit (flashVoicePe) meta;
          };
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          bay = {
            type = "app";
            program = lib.getExe projectPackages.${system}.bay;
            inherit (projectPackages.${system}.bay) meta;
          };
          flare = {
            type = "app";
            program = lib.getExe projectPackages.${system}.flare;
            inherit (projectPackages.${system}.flare) meta;
          };
        }
      );

      devShells =
        let
          mkShell =
            system:
            let
              pkgs = nixpkgs.legacyPackages.${system};
              piExtensionTypes = pkgs.callPackage ./packages/pi-extension-types.nix { };
            in
            {
              pituitary = import ./packages/pituitary/shell.nix { inherit pkgs; };
              dura = import ./packages/pituitary/shell.nix { inherit pkgs; };
              default = pkgs.mkShell {
                buildInputs = [
                  pkgs.nixd
                  pkgs.sops
                  pkgs.typescript
                  pkgs.biome
                  pkgs.nodejs
                ];
                # the pi extension sources resolve the pi API through this link, which
                # keeps tsserver and tsc working in editor sessions outside the shell
                shellHook = ''
                  config_dir="$(git rev-parse --show-toplevel)/modules/home-manager/pi/config"
                  if [ -L "$config_dir/node_modules" ] || [ ! -e "$config_dir/node_modules" ]; then
                    ln -sfn ${piExtensionTypes} "$config_dir/node_modules"
                  fi
                '';
              };
              infra = import ./infra/shell.nix {
                inherit nixpkgs system;
                inherit (inputs) bun2nix;
              };
            }
            // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
              bay = import ./packages/bay/shell.nix { inherit pkgs; };
            };
        in
        lib.genAttrs systems mkShell;
    };
}
