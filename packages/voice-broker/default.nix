{
  lib,
  python3Packages,
  pkg-config,
  webrtc-audio-processing,
  fetchPypi,
}:
let
  # The Live API client (gpt-live-1) starts at openai 3.x.
  openai = python3Packages.buildPythonPackage rec {
    pname = "openai";
    version = "3.16.2";
    format = "wheel";
    src = fetchPypi {
      inherit pname version format;
      dist = "py3";
      python = "py3";
      hash = "sha256-Zgp/gwfmYFNCroT/RCVBLnzRnl6bKY+XVQLfKhqaXV8=";
    };
    dependencies = with python3Packages; [
      anyio
      httpx2
      jiter
      pydantic
      sniffio
      typing-extensions
    ];
    # openai calls only jiter.from_json, which nixpkgs' jiter provides.
    pythonRelaxDeps = [ "jiter" ];
    pythonImportsCheck = [
      "openai"
      "openai.resources.live"
    ];
  };
in
python3Packages.buildPythonApplication {
  pname = "voice-broker";
  version = "0.1.0";
  pyproject = true;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./pyproject.toml
      ./setup.py
      ./src
      ./tests
    ];
  };

  build-system = with python3Packages; [
    setuptools
    pybind11
  ];
  nativeBuildInputs = [ pkg-config ];
  buildInputs = [ webrtc-audio-processing ];

  dependencies = [
    openai
  ]
  ++ (with python3Packages; [
    numpy
    soxr
    websockets
  ]);

  # The bridge runs in Hermes's own environment; aiohttp is needed here only
  # to exercise its real private Unix HTTP listener in the package tests.
  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    aiohttp
  ];

  meta.mainProgram = "voice-broker";
}
