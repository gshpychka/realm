{ lib }:
let
  ha = import ../../../../machines/home-assistant/configuration/lib.nix { inherit lib; };
  inherit (ha) devices;
  rejects = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
  # Expected protocol data is independent of the implementation's profiles.
  multiPress = {
    singlePress = [
      "remote_button_short_press"
      "remote_button_short_press"
    ];
    doublePress = [
      "remote_button_double_press"
      "remote_button_double_press"
    ];
    triplePress = [
      "remote_button_triple_press"
      "remote_button_triple_press"
    ];
    quadruplePress = [
      "remote_button_quadruple_press"
      "remote_button_quadruple_press"
    ];
    quintuplePress = [
      "remote_button_quintuple_press"
      "remote_button_quintuple_press"
    ];
    longPress = [
      "remote_button_long_press"
      "button"
    ];
  };
  fixtures = {
    roomLightswitch = multiPress;
    bedButton = multiPress;
    roomTableButton = multiPress;
    bedShelfButton = {
      singlePress = [
        "remote_button_short_press"
        "button_1"
      ];
      doublePress = [
        "remote_button_double_press"
        "button_1"
      ];
    };
    kitchenLightswitch = builtins.removeAttrs multiPress [
      "longPress"
      "quintuplePress"
    ];
    kitchenTableButton = builtins.removeAttrs multiPress [
      "longPress"
      "quadruplePress"
    ];
  };
  gestures = builtins.attrNames multiPress;
  # Exercise every helper against every registered device, including the
  # unsupported cells. Equality also forbids unexpected trigger IDs/fields.
  profileTests = lib.all (
    name:
    lib.all (
      gesture:
      let
        actual = ha.${gesture} devices.${name};
        expected = fixtures.${name}.${gesture};
      in
      if builtins.hasAttr gesture fixtures.${name} then
        actual == {
          trigger = "device";
          domain = "zha";
          device_id = devices.${name};
          type = builtins.elemAt expected 0;
          subtype = builtins.elemAt expected 1;
        }
      else
        rejects actual
    ) gestures
  ) (builtins.attrNames fixtures);
  # Each gesture must reject malformed inputs, unknown devices and devices
  # registered for other protocols/events.
  invalidDeviceTests = lib.all (
    gesture:
    lib.all (device: rejects (ha.${gesture} device)) [
      null
      true
      1
      [ devices.bedButton ]
      { device_id = devices.bedButton; }
      ""
      "unregistered-button"
      "{{ unchecked }}"
      ha.entities.light.bedLight
      devices.hotWaterValve
      devices.roomVoiceTarget
      devices.soundbarCloud
    ]
  ) gestures;
  valid = {
    alias = "Semantic button fixture";
    triggers = [ (ha.singlePress devices.bedShelfButton) ];
    actions = [ (ha.call "light.toggle" ha.entities.light.bedLight { }) ];
  };
in
assert profileTests;
assert invalidDeviceTests;
# Trigger IDs are ordinary native fields for callers that need branch labels.
assert
  (ha.automation (
    valid // { triggers = [ ((ha.longPress devices.bedButton) // { id = "held"; }) ]; }
  )).triggers == [
    {
      trigger = "device";
      domain = "zha";
      device_id = devices.bedButton;
      type = "remote_button_long_press";
      subtype = "button";
      id = "held";
    }
  ];
assert rejects (ha.automation (valid // { id = "optional-id"; }));
assert rejects (
  ha.automation (
    valid // { triggers = [ ((ha.singlePress devices.bedButton) // { id = "{{ unchecked }}"; }) ]; }
  )
);
assert rejects (
  ha.automation (valid // { actions = [ (ha.call "light.toggle" "{{ unchecked }}" { }) ]; })
);
builtins.deepSeq (ha.automation valid) true
