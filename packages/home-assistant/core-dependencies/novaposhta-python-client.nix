{
  buildPythonPackage,
  fetchPypi,
  poetry-core,
  httpx,
}:
buildPythonPackage (finalAttrs: {
  pname = "novaposhta-python-client";
  version = "0.1.10";
  pyproject = true;
  src = fetchPypi {
    pname = "novaposhta_python_client";
    inherit (finalAttrs) version;
    hash = "sha256-yKlI0HbSTj7ax931UNZ6ufHCyYPCnJHFNb+m2iEWO6c=";
  };
  build-system = [ poetry-core ];
  dependencies = [ httpx ];
  pythonImportsCheck = [ "novaposhta" ];
  # Import and manifest checks exercise the packaged runtime dependencies.
  doCheck = false;
})
