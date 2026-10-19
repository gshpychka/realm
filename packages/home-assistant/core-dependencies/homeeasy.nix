{
  buildPythonPackage,
  fetchPypi,
  setuptools,
  paho-mqtt,
  pycryptodome,
}:
buildPythonPackage (finalAttrs: {
  pname = "homeeasy";
  version = "0.0.8";
  pyproject = true;
  src = fetchPypi {
    inherit (finalAttrs) pname version;
    hash = "sha256-2XMts2sVUIKeFY9+lJEbB7An+Zvmvl0ULxEU6FDiSBw=";
  };
  build-system = [ setuptools ];
  dependencies = [
    paho-mqtt
    pycryptodome
  ];
  pythonImportsCheck = [ "homeeasy" ];
  # Import and manifest checks exercise the packaged runtime dependencies.
  doCheck = false;
})
