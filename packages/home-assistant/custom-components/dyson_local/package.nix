{ buildHomeAssistantComponent, fetchFromGitHub }:
buildHomeAssistantComponent (finalAttrs: {
  owner = "libdyson-wg";
  domain = "dyson_local";
  version = "1.5.7";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-dyson";
    tag = "v${finalAttrs.version}";
    hash = "sha256-V5RCepikTDrjZwi6MfRislpV2F9jR1MqwWxTq0GPBp4=";
  };
  patches = [ ./vacuum-api.patch ];
})
