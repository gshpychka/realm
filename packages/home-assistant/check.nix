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
  configFile = pkgs.writeText "ha-schema-configuration.json" (builtins.toJSON filteredConfiguration);
in
pkgs.runCommand "home-assistant-migration-qa"
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
    python ${../../scripts/home-assistant}/validate-mqtt.py \
      ${../../scripts/home-assistant}/prepare-mqtt.py ${pkgs.lib.getLib pkgs.mosquitto}/lib
    mkdir custom_components
    cp -r ${packages.customComponentSource}/. custom_components/
    chmod -R u+w custom_components
    # Reproduce only HA's own wrapper environment. MCP's separate dependencies
    # must not accidentally satisfy a missing HA/custom-component requirement.
    env -i HOME="$TMPDIR" PATH="$PATH" PYTHONDONTWRITEBYTECODE=1 \
      PYTHONPATH="${core.pythonPath}" ${python}/bin/python ${../../scripts/home-assistant/validate-ha.py} \
      ${configFile} ${../../machines/home-assistant/components.json} "$PWD"
    touch $out
  ''
