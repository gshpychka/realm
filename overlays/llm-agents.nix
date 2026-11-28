# packages from github:numtide/llm-agents.nix
inputs: _final: prev:
let
  llm-agents = inputs.llm-agents.packages.${prev.stdenv.hostPlatform.system};
in
{
  inherit (llm-agents)
    amp
    ccusage
    codex
    gemini-cli
    opencode
    claude-code
    pi
    ;
}
