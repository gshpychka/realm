{ pkgs }:
let
  nixFixture = pkgs.writeShellScriptBin "nix" ''
    set -eu
    [[ "$*" == 'eval --raw .#nixosConfigurations.home-assistant.config.virtualisation.oci-containers.containers.matter-server.image' ]]
    printf '%s\n' "$CONFIGURED_MATTER_IMAGE"
  '';
  registryFixture = pkgs.writeShellScriptBin "skopeo" ''
    set -eu
    printf '%s\n' "$*" >> "$UPDATER_LOG"
    if [[ $1 == inspect ]]; then
      [[ $UPDATER_MODE != matter-failure ]] || exit 29
      printf 'fixture manifest\n'
    elif [[ $UPDATER_MODE == matter-bad-digest ]]; then
      printf 'invalid digest\n'
    else
      printf 'sha256:%064d\n' 2
    fi
  '';
  sourceFixture = pkgs.writeShellScriptBin "nix-update" ''
    set -eu
    printf '%s\n' "$*" >> "$UPDATER_LOG"
    target=$2
    while [[ $# -gt 0 ]]; do
      if [[ $1 == --override-filename ]]; then file=$2; break; fi
      shift
    done
    case "$UPDATER_MODE" in
      skills-failure)
        printf '\n# interrupted hash edit\n' >> "$file"
        exit 23 ;;
      skills-success)
        sed -i 's/old-hash/new-hash/' "$file" ;;
      refresh-partial)
        printf '\n# refreshed %s\n' "$target" >> "$file"
        [[ $target != *.mcp ]] || exit 23 ;;
      targets-success)
        test -f "$file" ;;
      *) exit 2 ;;
    esac
  '';
  updater = pkgs.callPackage ../../update.nix {
    nix = nixFixture;
    nix-update = sourceFixture;
    skopeo = registryFixture;
  };
in
pkgs.runCommand "home-assistant-updater-tests" { nativeBuildInputs = [ pkgs.git ]; } ''
  mkdir repo
  cd repo
  git init -q
  mkdir -p packages/home-assistant machines/home-assistant
  export UPDATER_LOG=$PWD/commands
  export CONFIGURED_MATTER_IMAGE="ghcr.io/matter-js/matterjs-server:1.4.0@sha256:$(printf '%064d' 1)"
  cat > machines/home-assistant/services.nix <<EOF
  image = "$CONFIGURED_MATTER_IMAGE";
  EOF
  cp machines/home-assistant/services.nix matter-before
  export UPDATER_MODE=matter-success
  ${updater}/bin/update-home-assistant matter skip
  grep -Fx 'inspect --raw docker://ghcr.io/matter-js/matterjs-server:1.4.0' commands
  grep -F "matterjs-server:1.4.0@sha256:$(printf '%064d' 2)" machines/home-assistant/services.nix
  ${updater}/bin/update-home-assistant matter 2.0.0
  grep -Fx 'inspect --raw docker://ghcr.io/matter-js/matterjs-server:2.0.0' commands

  for mode in matter-failure matter-bad-digest; do
    cp matter-before machines/home-assistant/services.nix
    export UPDATER_MODE=$mode
    if ${updater}/bin/update-home-assistant matter skip; then exit 1; fi
    cmp matter-before machines/home-assistant/services.nix
  done
  export CONFIGURED_MATTER_IMAGE="ghcr.io/matter-js/matterjs-server@sha256:$(printf '%064d' 1)"
  cp commands commands-before
  if ${updater}/bin/update-home-assistant matter skip; then exit 1; fi
  cmp commands-before commands

  cat > packages/home-assistant/mcp.nix <<'EOF'
  # Preserve existing local edits on a failed skills fetch.
  rev = "1111111111111111111111111111111111111111";
  hash = "old-hash";
  EOF
  cp packages/home-assistant/mcp.nix skills-before
  export UPDATER_MODE=skills-failure
  result=0
  ${updater}/bin/update-home-assistant skills 2222222222222222222222222222222222222222 || result=$?
  test "$result" = 23
  cmp skills-before packages/home-assistant/mcp.nix
  export UPDATER_MODE=skills-success
  ${updater}/bin/update-home-assistant skills 2222222222222222222222222222222222222222
  grep -Fx 'rev = "2222222222222222222222222222222222222222";' packages/home-assistant/mcp.nix
  grep -Fx 'hash = "new-hash";' packages/home-assistant/mcp.nix
  grep -F -- '--no-src --custom-dep skills --override-filename packages/home-assistant/mcp.nix' commands

  # Refresh stops at the failing target and leaves earlier changes for review.
  printf 'fixture Core\n' > packages/home-assistant/core.nix
  export UPDATER_MODE=refresh-partial
  : > commands
  result=0
  ${updater}/bin/update-home-assistant refresh || result=$?
  test "$result" = 23
  test "$(wc -l < commands)" = 2
  grep -F '# refreshed legacyPackages.' packages/home-assistant/core.nix
  grep -F '# refreshed legacyPackages.' packages/home-assistant/mcp.nix

  # Refresh finds flat expressions and component directories with local assets.
  mkdir -p packages/home-assistant/custom-components/dyson_local \
    packages/home-assistant/core-dependencies packages/home-assistant/mcp-dependencies
  touch packages/home-assistant/custom-components/asusrouter.nix \
    packages/home-assistant/custom-components/dyson_local/package.nix
  for name in homeeasy translitua novaposhta-python-client croniter passlib; do
    touch "packages/home-assistant/core-dependencies/$name.nix"
  done
  for name in uv-build pydantic-monty python-dotenv; do
    touch "packages/home-assistant/mcp-dependencies/$name.nix"
  done
  export UPDATER_MODE=targets-success
  export CONFIGURED_MATTER_IMAGE="ghcr.io/matter-js/matterjs-server:1.4.0@sha256:$(printf '%064d' 1)"
  : > commands
  ${updater}/bin/update-home-assistant refresh
  test "$(wc -l < commands)" = 19
  grep -F -- '.componentPackages.asusrouter --version=skip' commands \
    | grep -F -- '--override-filename packages/home-assistant/custom-components/asusrouter.nix'
  grep -F -- '.componentPackages.dyson_local --version=skip' commands \
    | grep -F -- '--override-filename packages/home-assistant/custom-components/dyson_local/package.nix'
  grep -F -- '.core.python3Packages.homeeasy --version=skip' commands \
    | grep -F -- '--override-filename packages/home-assistant/core-dependencies/homeeasy.nix'
  grep -F -- '.mcp.updatePackages.pydantic-monty --version=skip' commands \
    | grep -F -- '--override-filename packages/home-assistant/mcp-dependencies/pydantic-monty.nix --custom-dep otherSource'
  grep -F -- '.mcp.updatePackages.python-dotenv --version=skip' commands \
    | grep -F -- '--override-filename packages/home-assistant/mcp-dependencies/python-dotenv.nix'
  grep -Fx 'inspect --raw docker://ghcr.io/matter-js/matterjs-server:1.4.0' commands
  cp commands commands-before
  if ${updater}/bin/update-home-assistant component ../mcp skip; then exit 1; fi
  cmp commands-before commands

  mkdir -p $out
  touch $out/passed
  echo 'Updater contracts passed: current-tag refresh, registry failures, skills rollback/success, sequential partial-failure behavior, component and dependency ownership paths.'
''
