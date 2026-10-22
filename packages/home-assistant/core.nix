{
  pkgs,
  home-assistant,
  extraComponents ? [ ],
  extraPackages ? _: [ ],
}:
let
  # Scoped optional test inputs need not rebuild an unchanged native runtime.
  # Fail evaluation if a future package update invalidates that equivalence.
  reuseNative =
    name: scoped:
    let
      native = pkgs.python314Packages.${name};
      runtime = package: map (dependency: dependency.drvPath) package.dependencies;
      propagated = package: map (dependency: dependency.drvPath) package.propagatedBuildInputs;
    in
    assert scoped.version == native.version;
    assert toString scoped.src == toString native.src;
    assert map toString (scoped.patches or [ ]) == map toString (native.patches or [ ]);
    assert (scoped.postPatch or "") == (native.postPatch or "");
    assert scoped.pythonModule.drvPath == native.pythonModule.drvPath;
    assert runtime scoped == runtime native;
    assert propagated scoped == propagated native;
    native;
  core = home-assistant.override {
    inherit extraComponents;
    packageOverrides = ps: previous: {
      # tqdm has no runtime dependencies. Its optional-feature tests pull Dask
      # into this scope; reuse the tested native package with the same runtime.
      tqdm = reuseNative "tqdm" previous.tqdm;
      # Only OpenAI's optional HTTPX2 tests use the scoped transport fixtures.
      # Its source, interpreter and complete runtime are the native package.
      openai = reuseNative "openai" previous.openai;
      # Memray's fork/self-tracing tests can loop under user-mode emulation.
      # Textual and Memray only differ through optional scoped test inputs;
      # use the already-tested native packages without changing their tests.
      textual = reuseNative "textual" previous.textual;
      memray = reuseNative "memray" previous.memray;
      pymodbus = ps.callPackage ./core-dependencies/pymodbus { inherit (previous) pymodbus; };
      pyrate-limiter = ps.callPackage ./core-dependencies/pyrate-limiter {
        inherit (previous) pyrate-limiter;
      };
      zigpy = ps.callPackage ./core-dependencies/zigpy { inherit (previous) zigpy; };
      python-overseerr = ps.callPackage ./core-dependencies/python-overseerr {
        inherit (previous) python-overseerr;
      };
      # Core and MCP share this native transport's deterministic test fixtures.
      httpcore2 = ps.callPackage ./core-dependencies/httpcore2 { inherit (previous) httpcore2; };
      # Core 2026.10.2 selects these aio-libs versions and frontend wheel.
      yarl = previous.yarl.overridePythonAttrs (
        finalAttrs: _previous: {
          version = "1.25.1";
          src = pkgs.fetchFromGitHub {
            owner = "aio-libs";
            repo = "yarl";
            tag = "v${finalAttrs.version}";
            hash = "sha256-cQsVglP3OqaQW95OYPlbWCFTs5p6L5wOzx7QCIqqJ9U=";
          };
        }
      );
      propcache = previous.propcache.overridePythonAttrs (
        finalAttrs: _previous: {
          version = "0.5.4";
          src = pkgs.fetchFromGitHub {
            owner = "aio-libs";
            repo = "propcache";
            tag = "v${finalAttrs.version}";
            hash = "sha256-grCraF0j7ytCungRVke841eiGp5ixbQlbtQocdZg/60=";
          };
        }
      );
      aiohttp = previous.aiohttp.overridePythonAttrs (
        finalAttrs: previousAttrs: {
          version = "3.14.5";
          src = pkgs.fetchFromGitHub {
            owner = "aio-libs";
            repo = "aiohttp";
            tag = "v${finalAttrs.version}";
            hash = "sha256-gSxqab8AYJ6PsMP1PYWUxQ8TJ9KtEehoekLD8ziBt+g=";
          };
          # 3.14.5 already includes both WebSocket Cython annotation fixes.
          # The nixpkgs backport targets 3.14.3 and cannot be applied again.
          patches = pkgs.lib.filter (
            patch: !(pkgs.lib.hasSuffix "cython-3.3.0-compat.patch" (toString patch))
          ) (previousAttrs.patches or [ ]);
          # The pinned release stores its pytest options in pytest.ini.
          postPatch = ''
            rm -r vendor
            patchShebangs tools
            touch .git
            substituteInPlace Makefile \
              --replace-fail "cythonize: .install-cython" "cythonize:"
            substituteInPlace pytest.ini \
              --replace-fail "ignore:Couldn't import C tracer:coverage.exceptions.CoverageWarning" ""
            # This newer constant has the same Cython 3.3 conflict with its
            # unsigned-int declaration in reader_c.pxd. Let the .pxd own the type.
            substituteInPlace aiohttp/_websocket/reader_py.py \
              --replace-fail "MSG_SIZE_OVERHEAD: Final[int] = 128" "MSG_SIZE_OVERHEAD = 128"
          '';
        }
      );
      home-assistant-frontend = previous.home-assistant-frontend.overridePythonAttrs (
        finalAttrs: _previous: {
          version = "20260930.4";
          src = pkgs.fetchPypi {
            pname = "home_assistant_frontend";
            inherit (finalAttrs) version;
            format = "wheel";
            python = "py3";
            dist = "py3";
            abi = "none";
            platform = "any";
            hash = "sha256-BcIH+2zmcg0XgnZrVKZ6zfS6uD8TOlYiBLly0GKGL8g=";
          };
        }
      );
      homeeasy = ps.callPackage ./core-dependencies/homeeasy.nix { };
      translitua = ps.callPackage ./core-dependencies/translitua.nix { };
      novaposhta-python-client = ps.callPackage ./core-dependencies/novaposhta-python-client.nix { };
      croniter = ps.callPackage ./core-dependencies/croniter.nix { };
      passlib = ps.callPackage ./core-dependencies/passlib.nix { };
    };
    extraPackages =
      ps:
      (with ps; [
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
      ])
      ++ extraPackages ps;
  };
in
core.overrideAttrs (_previous: rec {
  version = "2026.10.2";
  # The home-assistant-config check validates schemas, imports and behavior
  # in the pinned Core environment on either supported Linux architecture.
  doCheck = false;
  doInstallCheck = false;
  src = pkgs.fetchFromGitHub {
    owner = "home-assistant";
    repo = "core";
    tag = version;
    hash = "sha256-SIodDoo79MrCJPr+9fqXvs7Xbhz7Ei4AUonp9oECGng=";
  };
  sdist = pkgs.fetchPypi {
    pname = "homeassistant";
    inherit version;
    hash = "sha256-isFwBI1EwsmZPC+hrA7puokpEqrHTGVROe9a97DCFrs=";
  };
})
