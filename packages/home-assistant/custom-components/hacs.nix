{
  buildHomeAssistantComponent,
  fetchurl,
  aiogithubapi,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "hacs";
  domain = "hacs";
  version = "2.0.5";

  src = fetchurl {
    url = "https://github.com/hacs/integration/releases/download/${finalAttrs.version}/hacs.zip";
    hash = "sha256-l75rgkpPOOaDcozG3XI2f2uLrQpDQosbO5h6MIet9BM=";
  };
  unpackPhase = ''
    runHook preUnpack
    mkdir source
    unzip -q "$src" -d source
    sourceRoot=source
    runHook postUnpack
  '';
  dependencies = [ aiogithubapi ];
})
