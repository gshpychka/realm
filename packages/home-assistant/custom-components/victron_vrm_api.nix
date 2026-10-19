{ buildHomeAssistantComponent, fetchFromGitHub }:
buildHomeAssistantComponent (finalAttrs: {
  owner = "jayjojayson";
  domain = "victron_vrm_api";
  version = "1.8";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "hass-victron-vrm-api";
    tag = "v_${finalAttrs.version}";
    hash = "sha256-E/ygfDeoHwefKYvhcDzNurnkbos7EkcS0zG7rUpW2Ks=";
  };
})
