{ ha, ... }:
let
  inherit (ha) entities;
in
{
  services.home-assistant.config.scene = [
    {
      entities = {
        ${entities.light.bedLight} = "off";
        ${entities.light.cuteLights} = "off";
        ${entities.light.kitchenLights} = "off";
        ${entities.light.lavaLamp} = "off";
        ${entities.light.partyLight} = "off";
        ${entities.light.plantLight} = "off";
        ${entities.light.roomOverheadLights} = "off";
        ${entities.media_player.soundbar} = "off";
        ${entities.media_player.soundbarSmartthings2} = "off";
        ${entities.media_player.tv} = "off";
        ${entities.switch.dysonNightMode} = "on";
      };
      icon = "mdi:power-sleep";
      name = "Night";
    }
    {
      entities = {
        ${entities.light.kitchenLights} = "off";
        ${entities.light.roomOverheadLights} = "off";
      };
      icon = "mdi:television";
      name = "TV watching";
    }
  ];
}
