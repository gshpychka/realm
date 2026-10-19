{
  services.home-assistant.config.scene = [
    {
      id = "1741877284270";
      name = "Night";
      entities = {
        "light.bed_light" = {
          state = "off";
        };
        "media_player.tv" = {
          state = "off";
        };
        "light.party_light" = {
          state = "off";
        };
        "media_player.soundbar" = {
          state = "off";
        };
        "switch.air_conditioner_display" = {
          state = "unavailable";
        };
        "light.plant_light" = {
          state = "off";
        };
        "light.room_overhead_lights" = {
          state = "off";
        };
        "light.kitchen_lights" = {
          state = "off";
        };
        "light.cute_lights" = {
          state = "off";
        };
        "light.lava_lamp" = {
          state = "off";
        };
        "switch.dyson_night_mode" = {
          state = "on";
        };
        "media_player.soundbar_smartthings_2" = {
          state = "off";
        };
      };
      icon = "mdi:power-sleep";
    }
    {
      id = "1743964862836";
      name = "TV watching";
      entities = {
        "light.room_overhead_lights" = {
          state = "off";
        };
        "light.kitchen_lights" = {
          state = "off";
        };
      };
      icon = "mdi:television";
    }
  ];
}
