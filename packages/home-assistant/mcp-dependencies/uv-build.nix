{
  buildPythonPackage,
  fetchPypi,
  stdenv,
  autoPatchelfHook,
}:
let
  pname = "uv-build";
  version = "0.12.17";
  wheel =
    arch: hash:
    fetchPypi {
      pname = "uv_build";
      inherit version hash;
      format = "wheel";
      python = "py3";
      dist = "py3";
      abi = "none";
      platform =
        "manylinux_2_17_${arch}.manylinux2014_${arch}"
        + (if arch == "aarch64" then ".musllinux_1_1_aarch64" else "");
    };
  sources = {
    x86_64-linux = wheel "x86_64" "sha256-cxU7gqa2Mb3+gZUYRnQXn+e7Ee/HkQjovUTw3yVEIqs=";
    aarch64-linux = wheel "aarch64" "sha256-izEtKN73CuR0xI9wLp5EfN778xevWZuLCkuYc5WV8C4=";
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
  pythonImportsCheck = [ "uv_build" ];
  # Import checks validate the upstream wheel in the target Python environment.
  doCheck = false;
}
