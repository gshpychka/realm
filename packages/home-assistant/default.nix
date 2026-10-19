{ pkgs }:
let
  sources = builtins.fromJSON (builtins.readFile ./sources.json);
  components = builtins.fromJSON (builtins.readFile ../../machines/home-assistant/components.json);
  componentPatches = builtins.fromJSON (builtins.readFile ./component-patches.json);
  coverage = builtins.fromJSON (
    builtins.readFile ../../machines/home-assistant/integration-coverage.json
  );
  # The snapshot contains only installed public component code, scanned against
  # the inventory's credential values. Per-file hashes and upstream revisions
  # are recorded in components.json; no runtime state enters this derivation.
  componentSource = pkgs.runCommand "ha-custom-components-2026-10-18" { } ''
    mkdir -p $out
    tar -xzf ${../../machines/home-assistant/components.tar.gz} -C $out
    ${pkgs.lib.concatStringsSep "\n" (
      pkgs.lib.flatten (
        pkgs.lib.mapAttrsToList (
          domain: patches:
          map (patch: ''
            echo "${patch.source_sha256}  $out/${domain}/${patch.target}" | sha256sum -c -
            chmod -R u+w "$out/${domain}"
            ${pkgs.patch}/bin/patch --batch --fuzz=0 -p1 -d "$out/${domain}" < ${./. + "/${patch.file}"}
            echo "${patch.result_sha256}  $out/${domain}/${patch.target}" | sha256sum -c -
          '') patches
        ) componentPatches
      )
    )}
  '';
  pinnedPython =
    ps: name: dependencies: imports: buildSystem:
    let
      source = sources.${name};
    in
    ps.buildPythonPackage {
      pname = name;
      inherit (source) version;
      src = pkgs.fetchurl { inherit (source) url hash; };
      pyproject = true;
      build-system = buildSystem;
      inherit dependencies;
      pythonImportsCheck = imports;
      # These are package/import checks; never run integration/provider tests.
      doCheck = false;
    };
  # Official upstream wheels pin the exact native Rust extension/backend ABI
  # for both supported Linux architectures. No credentials enter these inputs.
  pinnedWheel =
    ps: name: dependencies: imports:
    let
      source = sources.${name};
      wheel = source.wheels.${pkgs.stdenv.hostPlatform.system};
    in
    ps.buildPythonPackage {
      pname = name;
      inherit (source) version;
      src = pkgs.fetchurl { inherit (wheel) url hash; };
      format = "wheel";
      inherit dependencies;
      nativeBuildInputs = [ pkgs.autoPatchelfHook ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib ];
      pythonImportsCheck = imports;
      doCheck = false;
    };
  mcpPython = pkgs.python314Packages.overrideScope (
    ps: _previous: {
      python-dotenv = pinnedWheel ps "python-dotenv" [ ] [ "dotenv" ];
      pydantic-monty = pinnedWheel ps "pydantic-monty" [ ps.typing-extensions ] [ "pydantic_monty" ];
    }
  );
  mcpSkills = pkgs.fetchFromGitHub {
    inherit (sources.ha-mcp-skills)
      owner
      repo
      rev
      hash
      ;
  };
  core = pkgs.home-assistant.override {
    packageOverrides = ps: previous: {
      # Upstream diagnostic tests mutate a process-wide ASCII delimiter. With
      # one pytest worker they contaminate unrelated framer tests. Reset only
      # that test fixture; keep every assertion and the runtime code unchanged.
      pymodbus = previous.pymodbus.overridePythonAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./pymodbus-test-isolation.patch ];
      });
      # A released semaphore slot may start a queued task before the second
      # equal-duration task finishes. Test capacity/causality, not timer ties.
      zigpy = previous.zigpy.overridePythonAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./zigpy-test-order.patch ];
      });
      yarl = previous.yarl.overridePythonAttrs (_: {
        version = sources.yarl.version;
        src = pkgs.fetchFromGitHub {
          owner = "aio-libs";
          repo = "yarl";
          tag = "v${sources.yarl.version}";
          inherit (sources.yarl) hash;
        };
      });
      propcache = previous.propcache.overridePythonAttrs (_: {
        version = sources.propcache.version;
        src = pkgs.fetchFromGitHub {
          owner = "aio-libs";
          repo = "propcache";
          tag = "v${sources.propcache.version}";
          inherit (sources.propcache) hash;
        };
      });
      aiohttp = previous.aiohttp.overridePythonAttrs (_: {
        version = sources.aiohttp.version;
        src = pkgs.fetchFromGitHub {
          owner = "aio-libs";
          repo = "aiohttp";
          tag = "v${sources.aiohttp.version}";
          inherit (sources.aiohttp) hash;
        };
        # 3.14.5 moved its pytest options from setup.cfg into pytest.ini.
        postPatch = ''
          rm -r vendor
          patchShebangs tools
          touch .git
          substituteInPlace Makefile \
            --replace-fail "cythonize: .install-cython" "cythonize:"
          substituteInPlace pytest.ini \
            --replace-fail "ignore:Couldn't import C tracer:coverage.exceptions.CoverageWarning" ""
        '';
      });
      home-assistant-frontend = previous.home-assistant-frontend.overridePythonAttrs (_: {
        version = sources.home-assistant-frontend.version;
        src = pkgs.fetchurl { inherit (sources.home-assistant-frontend) url hash; };
      });
      homeeasy = pinnedPython ps "homeeasy" (with ps; [
        paho-mqtt
        pycryptodome
      ]) [ "homeeasy" ] [ ps.setuptools ];
      translitua = pinnedPython ps "translitua" [ ] [ "translitua" ] [ ps.setuptools ];
      novaposhta-python-client = pinnedPython ps "novaposhta-python-client" [
        ps.httpx
      ] [ "novaposhta" ] [ ps.poetry-core ];
      croniter = pinnedPython ps "croniter" (with ps; [
        python-dateutil
        pytz
      ]) [ "croniter" ] [ ps.setuptools ];
      passlib = pinnedPython ps "passlib" [ ] [ "passlib" ] [ ps.setuptools ];
    };
    extraPackages =
      ps: with ps; [
        sentence-stream
        passlib
        homeeasy
        croniter
        watchdog
        aiogithubapi
        paho-mqtt
        beautifulsoup4
        python-dateutil
        asusrouter
        pymodbus
        websocket-client
        wakeonlan
        aiofiles
        casttube
        pytz
        groq
        stringcase
        translitua
        novaposhta-python-client
      ];
  };
in
{
  customComponentSource = componentSource;
  coreComponents =
    pkgs.lib.filter
      (
        name:
        builtins.elem name core.availableComponents
        && !builtins.elem name [
          "hassio"
          "raspberry_pi"
        ]
      )
      (
        pkgs.lib.unique (
          map (entry: entry.domain) coverage
          ++ pkgs.lib.concatMap (component: component.dependencies) (pkgs.lib.attrValues components)
          ++ [
            "default_config"
            "rest"
            "ffmpeg"
            "shell_command"
            "rest_command"
            "command_line"
          ]
        )
      );
  # 8.7 vendors FastMCP/MCP/websockets and changed to uv_build; inheriting the
  # 8.6 setuptools/external-FastMCP package would omit required dependencies.
  mcp = mcpPython.toPythonApplication (
    mcpPython.buildPythonPackage {
      pname = "ha-mcp";
      version = "8.7.0";
      pyproject = true;
      src = pkgs.fetchzip {
        url = "https://github.com/homeassistant-ai/ha-mcp/archive/refs/tags/v8.7.0.tar.gz";
        hash = "sha256-omVAr9b5TiOJxU7amS4OWSmu4cTUuaIrJc4bIyyiPz4=";
      };
      postPatch = ''
        mkdir -p src/ha_mcp/resources/skills-vendor
        cp -r ${mcpSkills}/. src/ha_mcp/resources/skills-vendor/
      '';
      build-system = [ (pinnedWheel mcpPython "uv-build" [ ] [ "uv_build" ]) ];
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
      pythonImportsCheck = [ "ha_mcp" ];
      postFixup = ''
        env -i HOME="$TMPDIR" PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 \
          PYTHONPATH="$out/${mcpPython.python.sitePackages}:$PYTHONPATH" \
          HOMEASSISTANT_URL=http://127.0.0.1:1 \
          HOMEASSISTANT_TOKEN=synthetic-packaging-fixture \
          MCP_SECRET_PATH=/synthetic-packaging-fixture \
          ENABLE_MANDATORY_BPS=true ENABLE_STRICT_MANDATORY_BPS=true \
          ${mcpPython.python.interpreter} ${../../scripts/home-assistant/validate-mcp.py} \
          ${./mcp-requirements.json}
      '';
      # Its upstream integration tests require a running HA. The isolated check
      # validates native HTTP imports, dependency metadata and gate resources.
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
    }
  );
  core = core.overrideAttrs (_previous: {
    version = sources.homeassistant.version;
    # Validation is the isolated config/schema/import check below, rather than
    # the entire upstream HA suite on the 4GB target or this small build host.
    doCheck = false;
    doInstallCheck = false;
    src = pkgs.fetchFromGitHub {
      owner = "home-assistant";
      repo = "core";
      tag = "2026.10.2";
      hash = "sha256-SIodDoo79MrCJPr+9fqXvs7Xbhz7Ei4AUonp9oECGng=";
    };
    sdist = pkgs.fetchurl { inherit (sources.homeassistant) url hash; };
  });
  customComponents = pkgs.lib.mapAttrsToList (
    domain: manifest:
    pkgs.runCommand "ha-component-${domain}-${manifest.version}"
      {
        passthru = {
          inherit domain;
          isHomeAssistantComponent = true;
        };
      }
      ''
        mkdir -p $out/custom_components
        cp -r ${componentSource}/${domain} $out/custom_components/${domain}
      ''
  ) components;
}
