{ lib }:
let
  entities = import ./entities.nix;
  devices = import ./devices.nix;
  buttonProfiles = import ./button-profiles.nix { inherit devices; };
  templateContracts = import ./templates.nix;
  templates = builtins.mapAttrs (_: contract: contract.source) templateContracts;
  sources = builtins.attrValues templates;
  ensure =
    kind: valid: value:
    assert lib.assertMsg valid "Invalid Home Assistant ${kind}";
    builtins.deepSeq value value;
  # These checks enforce native data shapes and checked template provenance.
  # HA's pinned schemas remain authoritative for action/domain-specific fields.
  native =
    value:
    if builtins.isAttrs value then
      lib.all native (builtins.attrValues value)
    else if builtins.isList value then
      lib.all native value
    else if builtins.isString value then
      !(lib.any (token: lib.hasInfix token value) [
        "{{"
        "{%"
        "{#"
      ])
      || builtins.elem value sources
    else
      value == null || builtins.isBool value || builtins.isInt value || builtins.isFloat value;
  checked = kind: value: ensure kind (native value) value;
  listOf =
    kind: constructor: values:
    ensure kind (builtins.isList values) (map constructor values);
  condition =
    value:
    if builtins.isString value then
      ensure "boolean template condition" (lib.any (
        contract: contract.source == value && contract.output == "boolean"
      ) (builtins.attrValues templateContracts)) value
    else
      ensure "condition" (builtins.isAttrs value && builtins.isString (value.condition or null)) (
        checked "condition body" (
          value
          // lib.optionalAttrs (value.condition == "template") {
            value_template = condition value.value_template;
          }
          // lib.optionalAttrs (value ? conditions) {
            conditions = listOf "conditions" condition value.conditions;
          }
        )
      );
  action =
    value:
    ensure "action"
      (
        builtins.isAttrs value
        &&
          builtins.length (
            builtins.filter (key: builtins.hasAttr key value) [
              "action"
              "condition"
              "variables"
              "if"
              "choose"
              "parallel"
              "sequence"
              "delay"
              "stop"
              "set_conversation_response"
            ]
          ) == 1
      )
      (
        checked "action body" (
          value
          // lib.optionalAttrs (value ? condition) (condition value)
          // lib.optionalAttrs (value ? action) {
            action = ensure "service name" (
              builtins.isString value.action && builtins.match "[a-z_]+\\.[a-z0-9_]+" value.action != null
            ) value.action;
          }
          // lib.optionalAttrs (value ? variables) {
            variables = ensure "variables" (builtins.isAttrs value.variables) value.variables;
          }
          // lib.optionalAttrs (value ? "if") { "if" = listOf "if conditions" condition value."if"; }
          // lib.optionalAttrs (value ? "then") { "then" = listOf "then actions" action value."then"; }
          // lib.optionalAttrs (value ? "else") { "else" = listOf "else actions" action value."else"; }
          // lib.optionalAttrs (value ? sequence) { sequence = listOf "sequence" action value.sequence; }
          // lib.optionalAttrs (value ? parallel) { parallel = listOf "parallel" action value.parallel; }
          // lib.optionalAttrs (value ? default) { default = listOf "default" action value.default; }
          // lib.optionalAttrs (value ? choose) {
            choose = listOf "choose" (
              branch:
              branch
              // {
                conditions = listOf "choose conditions" condition branch.conditions;
                sequence = listOf "choose sequence" action branch.sequence;
              }
            ) value.choose;
          }
        )
      );
  automation =
    value:
    ensure "automation"
      (builtins.isAttrs value && builtins.isString (value.alias or null) && !(value ? id))
      (
        checked "automation body" (
          value
          // {
            actions = listOf "automation actions" action value.actions;
            triggers = listOf "triggers" (
              trigger:
              ensure "trigger" (builtins.isAttrs trigger && builtins.isString (trigger.trigger or null)) trigger
            ) value.triggers;
          }
          // lib.optionalAttrs (value ? conditions) {
            conditions = listOf "automation conditions" condition value.conditions;
          }
        )
      );
  script =
    value:
    ensure "script" (builtins.isAttrs value && builtins.isString (value.alias or null)) (
      checked "script body" (value // { sequence = listOf "script sequence" action value.sequence; })
    );
  helpers =
    value:
    ensure "helpers"
      (
        builtins.isAttrs value
        && lib.all (
          domain:
          builtins.elem domain [
            "timer"
            "input_boolean"
            "input_button"
          ]
        ) (builtins.attrNames value)
      )
      (
        builtins.mapAttrs (
          domain: definitions:
          ensure "${domain} definitions" (builtins.isAttrs definitions) (
            builtins.mapAttrs (
              _: definition:
              ensure "${domain} helper" (
                builtins.isAttrs definition
                && builtins.isString (definition.name or null)
                && (!(definition ? restore) || builtins.isBool definition.restore)
                && (!(definition ? duration) || builtins.isString definition.duration)
              ) (checked "helper body" definition)
            ) definitions
          )
        ) value
      );
  areas = {
    room = "room";
    kitchen = "kitchen";
  };
  call =
    action: entity: data:
    {
      inherit action;
      target.entity_id = entity;
    }
    // (if data == { } then { } else { inherit data; });
  state = entity: value: {
    condition = "state";
    entity_id = entity;
    state = value;
  };
  # Device-offline events still need the low-level ZHA constructor.
  zha = device: type: subtype: {
    trigger = "device";
    domain = "zha";
    device_id = device;
    inherit type subtype;
  };
  buttonPress =
    gesture: device:
    ensure "${gesture} trigger (unknown button or unsupported gesture)"
      (
        builtins.isString device
        && builtins.hasAttr device buttonProfiles
        && builtins.hasAttr gesture buttonProfiles.${device}
      )
      (
        let
          event = buttonProfiles.${device}.${gesture};
        in
        checked "button trigger body" (zha device event.type event.subtype)
      );
in
{
  inherit
    entities
    devices
    areas
    call
    state
    templates
    templateContracts
    automation
    script
    helpers
    action
    condition
    zha
    ;

  # A list preserves dependency order; each HA action binds exactly one name.
  orderedVariables =
    bindings:
    listOf "ordered variables" (
      binding:
      action {
        variables = ensure "single variable binding" (
          builtins.isAttrs binding && builtins.length (builtins.attrNames binding) == 1
        ) binding;
      }
    ) bindings;

  # Callers name the gesture and device; protocol details live in one registry.
  singlePress = buttonPress "singlePress";
  doublePress = buttonPress "doublePress";
  triplePress = buttonPress "triplePress";
  longPress = buttonPress "longPress";
  quadruplePress = buttonPress "quadruplePress";
  quintuplePress = buttonPress "quintuplePress";

  announce = message: options: {
    action = "assist_satellite.announce";
    target.area_id = areas.room;
    data = {
      inherit message;
    }
    // options;
  };

  # Callers capture chamber_light_was_off before this sequence starts.
  printerSnapshot = filename: [
    {
      alias = "Light the chamber for the snapshot";
      "if" = [ (state entities.light.balconyH2CChamberLight "off") ];
      "then" = [
        (call "light.turn_on" entities.light.balconyH2CChamberLight { })
        { delay.seconds = 2; }
      ];
    }
    (call "camera.snapshot" entities.camera.balconyH2CCamera {
      filename = "/var/lib/hass/media/${filename}";
    })
    {
      alias = "Restore the chamber light";
      "if" = [ templates.restore_chamber ];
      "then" = [ (call "light.turn_off" entities.light.balconyH2CChamberLight { }) ];
    }
  ];
}
