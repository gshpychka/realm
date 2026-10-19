{ buildHomeAssistantComponent, fetchFromGitHub }:
buildHomeAssistantComponent (finalAttrs: {
  owner = "thomasloven";
  domain = "fontawesome";
  version = "2.3.0";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "hass-fontawesome";
    tag = "v.${finalAttrs.version}";
    hash = "sha256-9jNuBm4lJfv3oQENfEDnmo7x8tMEkhJU8QzwY5hPPxI=";
  };
})
