inputs: [
  (import ./llm-agents.nix inputs)
  (_final: prev: import ../packages { pkgs = prev; })
  (import ./docker.nix)
  (import ./openclaw.nix inputs)
  inputs.mcp-servers-nix.overlays.default
]
