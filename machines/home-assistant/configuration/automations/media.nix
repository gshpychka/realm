{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    call
    state
    longPress
    announce
    ;
in
{
  services.home-assistant.config.automation = map ha.automation [
    {
      alias = "Media / Goodnight";
      triggers = [
        {
          alias = "\"Goodnight\"";
          command = [
            "Goodnight"
            "Good night"
          ];
          trigger = "conversation";
        }
      ];
      actions = [
        (call "scene.turn_on" entities.scene.night { transition = 1; })
        { set_conversation_response = "Goodnight!"; }
      ];
    }
    {
      alias = "Media / Ask to activate Movie scene";
      description = "After dark, when Plex starts a fresh playback, offer the movie scene and open a 10s window in which a long press activates it.";
      triggers = [
        {
          trigger = "state";
          entity_id = entities.media_player.plexTv;
          from = [
            "idle"
            "standby"
            "unknown"
            "unavailable"
          ];
          to = "playing";
          for = {
            seconds = 10;
          };
        }
      ];
      conditions = [
        {
          after = "sunset";
          before = "sunrise";
          condition = "sun";
        }
        (state entities.timer.movieSceneCooldown "idle")
      ];
      actions = [
        (call "timer.start" entities.timer.movieSceneCooldown { })
        (announce "Hold the table button to activate the movie scene" { preannounce = true; })
        (call "timer.start" entities.timer.movieSceneOfferWindow { })
      ];
    }
    {
      alias = "Media / Activate Movie scene on Table button Long press";
      description = "Long press activates the movie scene only while the offer window timer is running; otherwise the same press falls through to the light toggles.";
      triggers = [ (longPress devices.roomTableButton) ];
      conditions = [ (state entities.timer.movieSceneOfferWindow "active") ];
      actions = [ (call "scene.turn_on" entities.scene.tvWatching { transition = 1; }) ];
    }
  ];
}
