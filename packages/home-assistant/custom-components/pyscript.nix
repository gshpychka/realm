{
  buildHomeAssistantComponent,
  fetchFromGitHub,
  croniter,
  watchdog,
}:
buildHomeAssistantComponent (finalAttrs: {
  owner = "custom-components";
  domain = "pyscript";
  version = "2.1.0";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "pyscript";
    tag = "${finalAttrs.version}";
    hash = "sha256-PGBlMAfkkW7GrZuGHHQgDK4ib1m2nDL7UWpsWkfRojM=";
  };
  dependencies = [
    croniter
    watchdog
  ];
})
