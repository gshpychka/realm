let
  entities = import ./entities.nix;
  devices = import ./devices.nix;
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
in
{
  inherit
    entities
    devices
    areas
    call
    state
    ;

  # IDs enable stored traces and stable registry identity. Names are independent
  # of display aliases; Nix remains the source of automation definitions.
  # Omit initial_state so HA restores temporary runtime on/off choices.
  automation = id: definition: { inherit id; } // definition;

  # Button presses and device-offline events have no equivalent entity state.
  zha = device: type: subtype: {
    trigger = "device";
    domain = "zha";
    device_id = device;
    inherit type subtype;
  };

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
      "if" = [ "{{ chamber_light_was_off }}" ];
      "then" = [ (call "light.turn_off" entities.light.balconyH2CChamberLight { }) ];
    }
  ];
}
