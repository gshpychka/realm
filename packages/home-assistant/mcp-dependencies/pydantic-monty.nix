{
  buildPythonPackage,
  fetchPypi,
  stdenv,
  autoPatchelfHook,
  typing-extensions,
}:
let
  pname = "pydantic-monty";
  version = "0.0.18";
  wheel =
    arch: hash:
    fetchPypi {
      pname = "pydantic_monty";
      inherit version hash;
      format = "wheel";
      python = "cp314";
      dist = "cp314";
      abi = "cp314";
      platform = "manylinux_2_17_${arch}.manylinux2014_${arch}";
    };
  sources = {
    x86_64-linux = wheel "x86_64" "sha256-gYOqjiQgqkwZJMwFuHyBQ/lTt8Fz8kDLfPIOCz+GXNs=";
    aarch64-linux = wheel "aarch64" "sha256-MkRD6nPrcL/VezTlVCePUlAVksRYDtxrlwiw09akL0Q=";
  };
in
buildPythonPackage {
  inherit pname version;
  format = "wheel";
  src = sources.${stdenv.hostPlatform.system};
  passthru.otherSource =
    sources.${if stdenv.hostPlatform.isAarch64 then "x86_64-linux" else "aarch64-linux"};
  nativeBuildInputs = [ autoPatchelfHook ];
  buildInputs = [ stdenv.cc.cc.lib ];
  dependencies = [ typing-extensions ];
  pythonImportsCheck = [ "pydantic_monty" ];
  # Import checks validate the upstream wheel in the target Python environment.
  doCheck = false;
}
