inputs: [
  (import ./llm-agents.nix inputs)
  (_final: prev: import ../packages { pkgs = prev; })
  (import ./docker.nix)
  (import ./openclaw.nix inputs)
  (import ./tmux.nix)
  inputs.mcp-servers-nix.overlays.default
]
