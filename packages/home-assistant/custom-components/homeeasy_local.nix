{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  homeeasy,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "ki0ki0";
  domain = "homeeasy_local";
  version = "1.1.2";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "homeeasy_ha_local";
    rev = "92a23dfcf8899bc0d035d9690c31d4cbd6165eef";
    hash = "sha256-EOfHNP0VpROQL7wkMG8Ndlc2b1IQ3vBQj1urxDi2Nso=";
  };
  dependencies = [ homeeasy ];
})
