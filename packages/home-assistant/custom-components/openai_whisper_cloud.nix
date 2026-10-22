{ buildHomeAssistantComponent, fetchFromGitHub }:
buildHomeAssistantComponent (finalAttrs: {
  owner = "fabio-garavini";
  domain = "openai_whisper_cloud";
  version = "2.0.0";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-openai-whisper-stt-api";
    tag = "${finalAttrs.version}";
    hash = "sha256-O7v1yggHId7HD0QDM41XrvG13mYVyMA2EbKh0rA5w24=";
  };
})
