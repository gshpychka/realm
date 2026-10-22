{
  python3,
  writeShellApplication,
  writeText,
  configuration,
}:
let
  declarations = writeText "home-assistant-declarations.json" (
    builtins.toJSON {
      inherit configuration;
      entities = import ../../../machines/home-assistant/configuration/entities.nix;
    }
  );
in
writeShellApplication {
  name = "home-assistant-preflight";
  text = ''
    exec ${python3}/bin/python3 ${./preflight.py} --declarations ${declarations} "$@"
  '';
  meta.description = "Read-only audit of a private HA snapshot against the declared configuration";
}
