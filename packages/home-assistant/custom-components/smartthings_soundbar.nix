{
  lib,
  buildHomeAssistantComponent,
  fetchFromGitHub,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "PiotrMachowski";
  domain = "smartthings_soundbar";
  version = "v1.0.6";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "Home-Assistant-custom-components-SmartThings-Soundbar";
    tag = "v${lib.removePrefix "v" finalAttrs.version}";
    hash = "sha256-QPBNLr30kqVLxAnESmtd+uQeOyjw9Lz06Szsb0qDEW0=";
  };
})
