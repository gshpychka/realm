{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  groq,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "HunorLaczko";
  domain = "groq_cloud_api";
  version = "0.2.4";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-groq-cloud-api";
    tag = "v${finalAttrs.version}";
    hash = "sha256-3Fcr3PojQN8gwh0CiTxY9VRGVVzgMa/0JzSAhCdC/lo=";
  };
  dependencies = [ groq ];
})
