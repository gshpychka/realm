{ pkgs }:
let
  inherit (pkgs) lib;
  core = pkgs.callPackage ./core.nix { };
  nativeComponent = pkgs.buildHomeAssistantComponent.override { home-assistant = core; };
  # Select the declared domain and stamp upstream development placeholders.
  buildHomeAssistantComponent =
    args:
    (nativeComponent args).overrideAttrs (old: {
      nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
        pkgs.jq
        pkgs.unzip
      ];
      postUnpack = (old.postUnpack or "") + ''
        if [ -d "$sourceRoot/custom_components/${old.domain}" ]; then
          sourceRoot="$sourceRoot/custom_components/${old.domain}"
        fi
      '';
      postPatch = (old.postPatch or "") + ''
        find . -type f -name '*.pyc' -delete
        find . -type d -name __pycache__ -empty -delete
        jq --arg version "$version" '.version = $version' manifest.json > manifest.tmp
        mv manifest.tmp manifest.json
      '';
    });
  componentPackages =
    lib.packagesFromDirectoryRecursive {
      callPackage =
        path: args:
        core.python3Packages.callPackage path (args // { inherit buildHomeAssistantComponent; });
      directory = ./custom-components;
    }
    // {
      samsungtv_smart = pkgs.home-assistant-custom-components.samsungtv-smart.override {
        inherit buildHomeAssistantComponent;
      };
    };
  customComponents = lib.attrValues componentPackages;
in
{
  inherit core componentPackages customComponents;
  mcp = pkgs.callPackage ./mcp.nix { };
  customComponentSource = pkgs.linkFarm "ha-custom-components" (
    map (component: {
      name = component.domain;
      path = "${component}/custom_components/${component.domain}";
    }) customComponents
  );
}
