{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  asusrouter,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "Vaskivskyi";
  domain = "asusrouter";
  version = "0.40.1";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-asusrouter";
    tag = "${finalAttrs.version}";
    hash = "sha256-NoorZl9zZdULA42JAXGp/65GDgiLuAMuavn1otJ2KSs=";
  };
  dependencies = [ asusrouter ];
})
