{ buildHomeAssistantComponent, fetchFromGitHub }:
buildHomeAssistantComponent (finalAttrs: {
  owner = "TegridyTate";
  domain = "hassarr";
  version = "0.2.0";

  src = fetchFromGitHub {
    inherit (finalAttrs) owner;
    repo = "Hassarr";
    rev = "156a5bb3a806af61e3c26e9f3018a909ad4a6eb3";
    hash = "sha256-Zxoq2qHYA77oKqrNSyOJLpMIkhP0fh4+QmFUvFLyHgo=";
  };
})
