{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  sentence-stream,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "sfortis";
  domain = "openai_tts";
  version = "3.11";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "openai_tts";
    tag = "v${finalAttrs.version}";
    hash = "sha256-eBSp1gKPB7NE2zJgs8+czdUrEN1qg7vsKSzr+5484pk=";
  };
  dependencies = [ sentence-stream ];
})
