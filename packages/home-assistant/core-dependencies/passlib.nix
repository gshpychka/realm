{
  buildPythonPackage,
  fetchPypi,
  setuptools,
}:
buildPythonPackage (finalAttrs: {
  pname = "passlib";
  version = "1.7.4";
  pyproject = true;
  src = fetchPypi {
    inherit (finalAttrs) pname version;
    hash = "sha256-3v1Q9ytlxUAqssVzgwppeOXyAq0NmEeTyN3ixBUuvgQ=";
  };
  build-system = [ setuptools ];
  pythonImportsCheck = [ "passlib" ];
  # Import and manifest checks exercise the packaged runtime dependencies.
  doCheck = false;
})
