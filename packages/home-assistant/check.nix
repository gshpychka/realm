{ pkgs, configuration }:
let
  packages = import ./. { inherit pkgs; };
  core = packages.core.override {
    extraComponents = packages.coreComponents;
  };
  python = core.python3Packages.python.withPackages (ps: [
    (ps.toPythonModule core)
  ]);
  # Match the native module's null filtering before YAML rendering. In
  # particular, selector type keys must survive it as explicit empty mappings.
  filteredConfiguration = pkgs.lib.converge (pkgs.lib.filterAttrsRecursive (
    _: value: value != null
  )) configuration;
  configFile = (pkgs.formats.yaml { }).generate "configuration.yaml" filteredConfiguration;
  templates = import ../../machines/home-assistant/configuration/templates.nix;
  literal = import ../../machines/home-assistant/configuration/template-literal.nix;
  # Include syntax-looking input, both quote styles, escapes, Unicode and native
  # JSON booleans/null in the actual serialization constructor's round trip.
  literalValues = [
    {
      text = "quotes: ' \" \\ \n Україна {{ injected }} {% if true %}";
      enabled = true;
      absent = null;
    }
    [
      "'\"\\\n"
      false
      null
      3
    ]
  ];
  templateFixtures = pkgs.writeText "ha-template-contracts.json" (
    builtins.toJSON {
      contracts = templates;
      literals = map (value: {
        source = "{{ ${literal value} }}";
        expected = value;
      }) literalValues;
    }
  );
  constructors = import ./constructors-test.nix { inherit (pkgs) lib; };
in
assert constructors;
pkgs.runCommand "home-assistant-config-qa"
  {
    nativeBuildInputs = [
      python
      packages.mcp
      pkgs.mosquitto
    ];
  }
  ''
    export HOME=$TMPDIR
    export PYTHONDONTWRITEBYTECODE=1
    env -i HOME="$TMPDIR" PATH="$PATH" ${packages.mcp}/bin/ha-mcp --version \
      | ${pkgs.gnugrep}/bin/grep -Fx 'ha-mcp 8.7.0'
    # Parse the native broker's auth/ACL configuration without opening a socket.
    mosquitto_passwd -b -c passwords fixture-user fixture-password
    printf 'topic readwrite #\n' > acl
    cat > mosquitto.conf <<EOF
    listener 18830 127.0.0.1
    allow_anonymous false
    plugin ${pkgs.lib.getLib pkgs.mosquitto}/lib/mosquitto_acl_file.so
    plugin_opt_acl_file $PWD/acl
    plugin ${pkgs.lib.getLib pkgs.mosquitto}/lib/mosquitto_password_file.so
    plugin_opt_password_file $PWD/passwords
    EOF
    mosquitto -c mosquitto.conf --test-config
    mkdir custom_components
    cp -r ${packages.customComponentSource}/. custom_components/
    chmod -R u+w custom_components
    # Reproduce only HA's own wrapper environment. MCP's separate dependencies
    # must not accidentally satisfy a missing HA/custom-component requirement.
    env -i HOME="$TMPDIR" PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 \
      PYTHONPATH="${core.pythonPath}" ${python}/bin/python ${./.}/validate-ha.py \
      ${configFile} "$PWD" ${templateFixtures} ${../../machines/home-assistant}
    ${python}/bin/python ${./test-runtime.py} ${../../machines/home-assistant}
    mkdir -p $out
    cp template-scope-inventory.json $out/
  ''
