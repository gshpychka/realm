{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  paho-mqtt,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "tomer-w";
  domain = "victron_mqtt";
  version = "2026.10.0";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-victron-mqtt";
    tag = "v${finalAttrs.version}";
    hash = "sha256-JGkHtXpQIhb7/UjGwc3Y7ugUvlQIvco2MSbdSI+bZu0=";
  };
  dependencies = [ paho-mqtt ];
})
