{
  pkgs,
  configuration,
  extraComponents,
}:
let
  packages = pkgs.callPackage ../. { };
  core = packages.core.override {
    inherit extraComponents;
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
  templates = import ../../../machines/home-assistant/configuration/templates.nix;
  literal = import ../../../machines/home-assistant/configuration/template-literal.nix;
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
  constructors = import ./nix/constructors-test.nix { inherit (pkgs) lib; };
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
    ${python}/bin/python ${./.}/python/layout.py ${../../..}
    env -i HOME="$TMPDIR" PATH="$PATH" ${packages.mcp}/bin/ha-mcp --version \
      | ${pkgs.gnugrep}/bin/grep -Fx 'ha-mcp ${packages.mcp.version}'
    # The broker's test-config mode validates auth/ACL syntax with fixture files.
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
    cp -rL ${packages.customComponentSource}/. custom_components/
    chmod -R u+w custom_components
    # Use HA's wrapper environment to check that HA and custom components resolve
    # their dependencies from the declared Core Python path.
    env -i HOME="$TMPDIR" PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 \
      PYTHONPATH="${core.pythonPath}" ${python}/bin/python ${./.}/python/validate-ha.py \
      ${configFile} "$PWD" ${templateFixtures} ${../../../machines/home-assistant}
    ${python}/bin/python ${./.}/python/test-runtime.py ${../../../machines/home-assistant}
    mkdir -p $out
    cp template-scope-inventory.json $out/
  ''
