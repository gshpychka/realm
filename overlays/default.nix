inputs: [
  (import ./llm-agents.nix inputs)
  (_final: prev: import ../packages { pkgs = prev; })
  (import ./openclaw.nix inputs)
  inputs.mcp-servers-nix.overlays.default
]
