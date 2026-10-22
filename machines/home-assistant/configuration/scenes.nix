{ ha, ... }:
let
  inherit (ha) entities;
in
{
  services.home-assistant.config.scene = [
    {
      # Preserve scene.night in the restored HA entity registry.
      id = "1741877284270";
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
      # Preserve scene.tv_watching in the restored HA entity registry.
      id = "1743964862836";
      entities = {
        ${entities.light.kitchenLights} = "off";
        ${entities.light.roomOverheadLights} = "off";
      };
      icon = "mdi:television";
      name = "TV watching";
    }
  ];
}
