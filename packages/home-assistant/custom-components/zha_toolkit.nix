{
  lib,
  buildHomeAssistantComponent,
  fetchFromGitHub,
  aiofiles,
  pytz,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "mdeweerd";
  domain = "zha_toolkit";
  version = "v1.2.5";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "zha-toolkit";
    tag = "v${lib.removePrefix "v" finalAttrs.version}";
    hash = "sha256-ryAVsxihBGqge0fXJ90px82rvsmb5ecJdUUImcZigDM=";
  };
  dependencies = [
    aiofiles
    pytz
  ];
})
