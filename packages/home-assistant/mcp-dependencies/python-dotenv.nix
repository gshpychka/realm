{
  buildPythonPackage,
  fetchPypi,
  stdenv,
  autoPatchelfHook,
}:
buildPythonPackage (finalAttrs: {
  pname = "python-dotenv";
  version = "1.2.4";
  format = "wheel";
  src = fetchPypi {
    pname = "python_dotenv";
    inherit (finalAttrs) version;
    format = "wheel";
    python = "py3";
    dist = "py3";
    abi = "none";
    platform = "any";
    hash = "sha256-Qiaails/1U/6bz2EsYq+1QBkcXV2tOzwPcSlXYqgT9w=";
  };
  nativeBuildInputs = [ autoPatchelfHook ];
  buildInputs = [ stdenv.cc.cc.lib ];
  pythonImportsCheck = [ "dotenv" ];
  # Import checks validate the upstream wheel in the target Python environment.
  doCheck = false;
})
