{
  buildPythonPackage,
  fetchPypi,
  setuptools,
}:
buildPythonPackage (finalAttrs: {
  pname = "translitua";
  version = "1.3.2";
  pyproject = true;
  src = fetchPypi {
    inherit (finalAttrs) pname version;
    hash = "sha256-Pn+4JRnQvy7ZN3ny9EERPVe4T/qTTXUVsjvzsCk62/E=";
  };
  build-system = [ setuptools ];
  pythonImportsCheck = [ "translitua" ];
  # Import and manifest checks exercise the packaged runtime dependencies.
  doCheck = false;
})
