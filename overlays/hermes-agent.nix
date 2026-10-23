inputs: _final: prev: {
  hermes-agent = inputs.hermes-agent.packages.${prev.stdenv.hostPlatform.system}.default;
}
