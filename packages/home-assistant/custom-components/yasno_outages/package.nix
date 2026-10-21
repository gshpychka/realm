{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  python-dateutil,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "denysdovhan";
  domain = "yasno_outages";
  version = "3.1.4";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "ha-yasno-outages";
    tag = "v${finalAttrs.version}";
    hash = "sha256-U6K87lM0IrL8YfkU5L5ywW83DC6U4B+fwp4ZO3UJDgs=";
  };
  # Upstream (v3.1.4 and main as of 2026-10-21) only republishes entities on
  # network polls, so the electricity sensor and calendar keep the previous
  # slot for up to one scan interval after a scheduled start or end.
  patches = [ ./schedule-boundaries.patch ];
  dependencies = [ python-dateutil ];
})
