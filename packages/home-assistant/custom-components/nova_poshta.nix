{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  stringcase,
  translitua,
  novaposhta-python-client,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "krasnoukhov";
  domain = "nova_poshta";
  version = "1.3.4";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "homeassistant-nova-poshta";
    tag = "v${finalAttrs.version}";
    hash = "sha256-qaE4vawbYB6AaeQiNQ09CBj0kKgrQ1cWUZm6JJKJ/e8=";
  };
  dependencies = [
    stringcase
    translitua
    novaposhta-python-client
  ];
})
