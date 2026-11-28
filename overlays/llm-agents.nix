# packages from github:numtide/llm-agents.nix
inputs: _final: prev:
let
  llm-agents = inputs.llm-agents.packages.${prev.stdenv.hostPlatform.system};
in
{
  inherit (llm-agents)
    amp
    ccusage
    gemini-cli
    opencode
    claude-code
    pi
    ;

  codex =
    if prev.stdenv.hostPlatform.isDarwin then
      llm-agents.codex.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./codex-macos-security.patch ];
      })
    else
      llm-agents.codex;
}
