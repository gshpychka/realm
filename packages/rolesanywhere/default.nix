{
  lib,
  python3Packages,
  tpm2-tools,
}:
python3Packages.buildPythonApplication {
  pname = "rolesanywhere";
  version = "0.1.0";
  pyproject = true;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./pyproject.toml
      ./src
      ./tests
    ];
  };

  build-system = [ python3Packages.setuptools ];

  dependencies = [ python3Packages.cryptography ];

  makeWrapperArgs = [
    "--prefix"
    "PATH"
    ":"
    (lib.makeBinPath [ tpm2-tools ])
  ];

  nativeCheckInputs = [ python3Packages.pytestCheckHook ];

  meta.mainProgram = "rolesanywhere";
}
