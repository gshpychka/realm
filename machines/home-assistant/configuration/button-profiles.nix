{ devices }:
let
  typeAsSubtype = type: {
    inherit type;
    subtype = type;
  };
  multiPress = {
    singlePress = typeAsSubtype "remote_button_short_press";
    doublePress = typeAsSubtype "remote_button_double_press";
    triplePress = typeAsSubtype "remote_button_triple_press";
    quadruplePress = typeAsSubtype "remote_button_quadruple_press";
    quintuplePress = typeAsSubtype "remote_button_quintuple_press";
  };
  multiPressWithLong = multiPress // {
    longPress = {
      type = "remote_button_long_press";
      subtype = "button";
    };
  };
  button1 = builtins.mapAttrs (_: event: event // { subtype = "button_1"; }) {
    inherit (multiPress) singlePress doublePress;
  };
in
{
  # Register evidenced household mappings for each device's supported gestures.
  # Press counts and long-press protocols are specific to each device.
  ${devices.roomLightswitch} = multiPressWithLong;
  ${devices.bedButton} = multiPressWithLong;
  ${devices.roomTableButton} = multiPressWithLong;
  ${devices.bedShelfButton} = button1;
  ${devices.kitchenLightswitch} = builtins.removeAttrs multiPress [ "quintuplePress" ];
  ${devices.kitchenTableButton} = builtins.removeAttrs multiPress [ "quadruplePress" ];
}
