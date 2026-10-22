# Immutable machine identity includes disk geometry: a booted warm base cannot shrink.
{
  metadata,
  disk,
  resources,
}:
let
  revision = builtins.hashString "sha256" (
    builtins.toJSON {
      metadata = builtins.unsafeDiscardStringContext (toString metadata);
      disk = builtins.unsafeDiscardStringContext (toString disk);
      inherit resources;
    }
  );
in
{
  inherit revision resources;
  base = "bay-base-${builtins.substring 0 40 revision}";
}
