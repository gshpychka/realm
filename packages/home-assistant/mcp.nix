{ pkgs }:
let
  # MCP's vendored FastMCP requires these newer wheel versions and uv backend.
  mcpPython = pkgs.python314Packages.overrideScope (
    ps: previous: {
      # Only Authlib's optional web-framework tests depend on this scope's
      # dotenv override. Its runtime is unchanged, so reuse the tested package.
      authlib =
        let
          native = pkgs.python314Packages.authlib;
          runtime = package: map (dependency: dependency.drvPath) package.dependencies;
        in
        assert previous.authlib.version == native.version;
        assert toString previous.authlib.src == toString native.src;
        assert map toString (previous.authlib.patches or [ ]) == map toString (native.patches or [ ]);
        assert (previous.authlib.postPatch or "") == (native.postPatch or "");
        assert previous.authlib.pythonModule.drvPath == native.pythonModule.drvPath;
        assert runtime previous.authlib == runtime native;
        native;
      python-dotenv = ps.callPackage ./mcp-dependencies/python-dotenv.nix { };
      pydantic-monty = ps.callPackage ./mcp-dependencies/pydantic-monty.nix { };
    }
  );
  buildBackend = mcpPython.callPackage ./mcp-dependencies/uv-build.nix { };
  mcpSkills = pkgs.fetchFromGitHub {
    owner = "homeassistant-ai";
    repo = "skills";
    rev = "7690c5ea14e5c842bb143dbe5725ed48fe5449db";
    hash = "sha256-1cWUl+x2DudIZm8uRQ2OJ3KgVEqZLPyKlJRJW2qT9xs=";
  };
in
mcpPython.toPythonApplication (
  mcpPython.buildPythonPackage (finalAttrs: {
    pname = "ha-mcp";
    version = "8.7.0";
    pyproject = true;
    src = pkgs.fetchzip {
      url = "https://github.com/homeassistant-ai/ha-mcp/archive/refs/tags/v${finalAttrs.version}.tar.gz";
      hash = "sha256-omVAr9b5TiOJxU7amS4OWSmu4cTUuaIrJc4bIyyiPz4=";
    };
    postPatch = ''
      mkdir -p src/ha_mcp/resources/skills-vendor
      cp -r ${mcpSkills}/. src/ha_mcp/resources/skills-vendor/
    '';
    build-system = [ buildBackend ];
    dependencies =
      (with mcpPython; [
        anyio
        authlib
        cyclopts
        exceptiongroup
        griffelib
        httpx2
        joserfc
        jsonref
        jsonschema
        jsonschema-path
        openapi-pydantic
        opentelemetry-api
        platformdirs
        psutil
        py-key-value-aio
        pydantic-settings
        pyjwt
        pyperclip
        python-multipart
        pyyaml
        rich
        sse-starlette
        starlette
        typing-extensions
        typing-inspection
        uncalled-for
        uvicorn
        watchfiles
        httpx
        pydantic
        python-dotenv
        truststore
        cryptography
        pydantic-monty
        tzdata
        packaging
      ])
      ++ mcpPython.httpx.optional-dependencies.socks
      ++ mcpPython.pydantic.optional-dependencies.email
      ++ mcpPython.pyjwt.optional-dependencies.crypto
      ++ mcpPython.py-key-value-aio.optional-dependencies.filetree
      ++ mcpPython.py-key-value-aio.optional-dependencies.keyring
      ++ mcpPython.py-key-value-aio.optional-dependencies.memory;
    passthru = {
      skills = mcpSkills;
      updatePackages = {
        inherit (mcpPython) python-dotenv pydantic-monty;
        uv-build = buildBackend;
      };
    };
    pythonImportsCheck = [ "ha_mcp" ];
    postFixup = ''
      env -i HOME="$TMPDIR" PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 \
        PYTHONPATH="$out/${mcpPython.python.sitePackages}:$PYTHONPATH" \
        HOMEASSISTANT_URL=http://127.0.0.1:1 \
        HOMEASSISTANT_TOKEN=synthetic-packaging-fixture \
        MCP_SECRET_PATH=/synthetic-packaging-fixture \
        ENABLE_MANDATORY_BPS=true ENABLE_STRICT_MANDATORY_BPS=true \
        ${mcpPython.python.interpreter} ${./tests/mcp/check.py}
    '';
    # Package validation checks native HTTP imports, dependency metadata and
    # gate resources with synthetic settings and blocked socket connections.
    doCheck = false;
    meta = {
      description = "Home Assistant MCP server with isolated pinned native dependencies";
      homepage = "https://github.com/homeassistant-ai/ha-mcp";
      license = pkgs.lib.licenses.mit;
      mainProgram = "ha-mcp";
      platforms = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    };
  })
)
