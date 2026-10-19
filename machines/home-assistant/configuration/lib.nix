{ lib }:
let
  entities = import ./entities.nix;
  devices = import ./devices.nix;
  buttonProfiles = import ./button-profiles.nix { inherit devices; };
  templateContracts = import ./templates.nix;
  templates = builtins.mapAttrs (_: contract: contract.source) templateContracts;
  constructors = import ./constructors.nix { inherit lib templateContracts; };
  inherit (constructors)
    ensure
    checked
    listOf
    condition
    action
    automation
    script
    helpers
    ;
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
