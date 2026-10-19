{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  passlib,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "vithurshanselvarajah";
  domain = "glinet_router";
  version = "1.6.5";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-glinet-router";
    tag = "v${finalAttrs.version}";
    hash = "sha256-IRRpnQI841jgYTvZDhTJNQz5/TPUP9s0Y7NJ0lJpD2k=";
  };
  dependencies = [ passlib ];
})
