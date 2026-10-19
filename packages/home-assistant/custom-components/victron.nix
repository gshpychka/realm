{
  lib,
  buildHomeAssistantComponent,
  fetchFromGitHub,
  pymodbus,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "sfstar";
  domain = "victron";
  version = "v0.7.0-beta-6";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "hass-victron";
    tag = "v${lib.removePrefix "v" finalAttrs.version}";
    hash = "sha256-tzhaFwwWxaVSt5+JeHToFKjgn7MVEAqMMpWgNay9Pl4=";
  };
  dependencies = [ pymodbus ];
})
