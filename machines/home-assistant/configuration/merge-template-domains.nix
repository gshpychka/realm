# Keep the household registry flat without silently shadowing public names.
domains:
builtins.foldl' (
  registry: domain:
  assert builtins.all (name: !(builtins.hasAttr name registry)) (builtins.attrNames domain);
  registry // domain
) { } domains
