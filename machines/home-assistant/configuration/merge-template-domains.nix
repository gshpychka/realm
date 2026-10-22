# Merge domain programs into a flat registry and reject duplicate public names.
domains:
builtins.foldl' (
  registry: domain:
  assert builtins.all (name: !(builtins.hasAttr name registry)) (builtins.attrNames domain);
  registry // domain
) { } domains
