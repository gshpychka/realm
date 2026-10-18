inputs: [
  (import ./llm-agents.nix inputs)
  (import ./hermes-agent.nix inputs)
  (_final: prev: import ../packages { pkgs = prev; })
  (import ./tmux.nix)
  (import ./openclaw.nix inputs)
  inputs.mcp-servers-nix.overlays.default
]
