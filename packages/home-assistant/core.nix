{
  pkgs,
  home-assistant,
  extraComponents ? [ ],
  extraPackages ? _: [ ],
}:
let
  core = home-assistant.override {
    inherit extraComponents;
    packageOverrides = ps: previous: {
      # Upstream diagnostic tests mutate a process-wide ASCII delimiter. With
      # one pytest worker they contaminate unrelated framer tests. Reset the
      # delimiter between tests to isolate each fixture.
      pymodbus = previous.pymodbus.overridePythonAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./patches/pymodbus/pymodbus-test-isolation.patch ];
      });
      # A released semaphore slot may start a queued task before the second
      # equal-duration task finishes. Test semaphore capacity and task causality.
      zigpy = previous.zigpy.overridePythonAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ./patches/zigpy/zigpy-test-order.patch ];
      });
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
        finalAttrs: _previous: {
          version = "3.14.5";
          src = pkgs.fetchFromGitHub {
            owner = "aio-libs";
            repo = "aiohttp";
            tag = "v${finalAttrs.version}";
            hash = "sha256-gSxqab8AYJ6PsMP1PYWUxQ8TJ9KtEehoekLD8ziBt+g=";
          };
          # The pinned release stores its pytest options in pytest.ini.
          postPatch = ''
            rm -r vendor
            patchShebangs tools
            touch .git
            substituteInPlace Makefile \
              --replace-fail "cythonize: .install-cython" "cythonize:"
            substituteInPlace pytest.ini \
              --replace-fail "ignore:Couldn't import C tracer:coverage.exceptions.CoverageWarning" ""
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
      homeeasy = ps.callPackage ./python/homeeasy.nix { };
      translitua = ps.callPackage ./python/translitua.nix { };
      novaposhta-python-client = ps.callPackage ./python/novaposhta-python-client.nix { };
      croniter = ps.callPackage ./python/croniter.nix { };
      passlib = ps.callPackage ./python/passlib.nix { };
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
  # in the pinned Core environment as a dependency of the Pi system build.
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
