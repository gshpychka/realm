{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  beautifulsoup4,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "greghesp";
  domain = "bambu_lab";
  version = "2.2.26";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-bambulab";
    tag = "v${finalAttrs.version}";
    hash = "sha256-9KsIzem7BjImUW+BTnAUYJ7CnU5bFpet7D2HhmOwTbA=";
  };
  dependencies = [ beautifulsoup4 ];
})
