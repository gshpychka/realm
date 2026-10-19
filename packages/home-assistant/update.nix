{
  writeShellApplication,
  nix-update,
  nix,
  git,
  skopeo,
  gnused,
  gnugrep,
  stdenv,
}:
writeShellApplication {
  name = "update-home-assistant";
  meta.description = "Select and refresh Home Assistant package sources and the Matter image";
  runtimeInputs = [
    nix-update
    nix
    git
    skopeo
    gnused
    gnugrep
  ];
  text = ''
    usage() {
      cat <<'HELP'
    Usage: nix run .#update-home-assistant -- TARGET [NAME] VERSION
      core VERSION                 Core Git source and translation sdist
      component DOMAIN VERSION     Local custom component source
      dependency NAME VERSION      Core compatibility dependency
      mcp VERSION                  MCP source
      mcp-dependency NAME VERSION   MCP wheel, both Linux architectures
      skills COMMIT                MCP skill resources at an exact Git commit
      matter VERSION               Matter.js tag and immutable registry digest
      refresh                      Recompute every local hash at its current version
    VERSION is an explicit upstream version or "skip" to refresh the current hash.
    Samsung TV and other native packages follow `nix flake update nixpkgs`.
    Updates need public network access; credentials are optional.
    Run the scoped offline QA documented in machines/home-assistant/README.md afterwards.
    HELP
    }
    if [[ $# == 0 || ''${1-} == --help || ''${1-} == -h ]]; then
      usage
      exit 0
    fi
    cd "$(git rev-parse --show-toplevel)"
    base=legacyPackages.${stdenv.hostPlatform.system}.homeAssistant
    update() {
      nix-update --flake "$base.$1" --version="$2" \
        --option builders "" --option max-jobs 1 --option cores 1 "''${@:3}"
    }
    target=$1
    shift
    case "$target" in
      core|mcp)
        [[ $# == 1 ]] || { usage >&2; exit 2; }
        if [[ $target == core ]]; then
          update core "$1" --custom-dep sdist --override-filename packages/home-assistant/core.nix
        else
          update mcp "$1" --override-filename packages/home-assistant/mcp.nix
        fi
        ;;
      component)
        [[ $# == 2 && -f packages/home-assistant/custom-components/$1.nix ]] \
          || { usage >&2; exit 2; }
        case "$1" in
          hassarr|homeeasy_local)
            [[ $2 == skip ]] || { echo 'Set the reviewed version/rev in the component expression, then use skip.' >&2; exit 2; } ;;
        esac
        update "componentPackages.$1" "$2" --override-filename "packages/home-assistant/custom-components/$1.nix"
        ;;
      dependency)
        [[ $# == 2 ]] || { usage >&2; exit 2; }
        case "$1" in
          aiohttp|yarl|propcache|home-assistant-frontend|homeeasy|translitua|novaposhta-python-client|croniter|passlib)
            file=packages/home-assistant/python/$1.nix
            [[ -f $file ]] || file=packages/home-assistant/core.nix
            update "core.python3Packages.$1" "$2" --override-filename "$file" ;;
          *) usage >&2; exit 2 ;;
        esac
        ;;
      mcp-dependency)
        [[ $# == 2 ]] || { usage >&2; exit 2; }
        case "$1" in
          uv-build|pydantic-monty|python-dotenv)
            extra=()
            if [[ $1 != python-dotenv ]]; then extra=(--custom-dep otherSource); fi
            update "mcp.updatePackages.$1" "$2" --override-filename "packages/home-assistant/python/$1.nix" "''${extra[@]}" ;;
          *) usage >&2; exit 2 ;;
        esac
        ;;
      skills)
        [[ $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || { usage >&2; exit 2; }
        sed -i -E "s/rev = \"[0-9a-f]{40}\";/rev = \"$1\";/" packages/home-assistant/mcp.nix
        update mcp skip --no-src --custom-dep skills --override-filename packages/home-assistant/mcp.nix
        ;;
      matter)
        [[ $# == 1 && $1 =~ ^[0-9A-Za-z._-]+$ ]] || { usage >&2; exit 2; }
        image=ghcr.io/matter-js/matterjs-server
        work=$(mktemp -d)
        trap 'rm -rf "$work"' EXIT
        skopeo inspect --raw "docker://$image:$1" > "$work/manifest"
        digest=$(skopeo manifest-digest "$work/manifest")
        [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]
        sed -i -E "s|image = \"$image:[^\"]+\";|image = \"$image:$1@$digest\";|" machines/home-assistant/services.nix
        echo "$image:$1@$digest"
        ;;
      refresh)
        [[ $# == 0 ]] || { usage >&2; exit 2; }
        "$0" core skip
        "$0" mcp skip
        update mcp skip --no-src --custom-dep skills --override-filename packages/home-assistant/mcp.nix
        for file in packages/home-assistant/custom-components/*.nix; do
          domain=''${file##*/}
          "$0" component "''${domain%.nix}" skip
        done
        for name in aiohttp yarl propcache home-assistant-frontend homeeasy translitua novaposhta-python-client croniter passlib; do
          "$0" dependency "$name" skip
        done
        for name in uv-build pydantic-monty python-dotenv; do
          "$0" mcp-dependency "$name" skip
        done
        image=$(nix eval --raw .#nixosConfigurations.home-assistant.config.virtualisation.oci-containers.containers.matter-server.image)
        version=''${image#*:}
        "$0" matter "''${version%@*}"
        ;;
      *) usage >&2; exit 2 ;;
    esac
  '';
}
