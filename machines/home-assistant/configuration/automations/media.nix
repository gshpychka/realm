{ ha, ... }:
let
  inherit (ha)
    entities
    devices
    call
    state
    zha
    announce
    ;
in
{
  services.home-assistant.config.automation = [
    {
      actions = [
        (call "scene.turn_on" entities.scene.night { transition = 1; })
        { set_conversation_response = "Goodnight!"; }
      ];
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
    }
    {
      actions = [
        (call "timer.start" entities.timer.movieSceneCooldown { })
        (announce "Hold the table button to activate the movie scene" { preannounce = true; })
        (call "timer.start" entities.timer.movieSceneOfferWindow { })
      ];
      alias = "Media / Ask to activate Movie scene";
      conditions = [
        {
          after = "sunset";
          before = "sunrise";
          condition = "sun";
        }
        (state entities.timer.movieSceneCooldown "idle")
      ];
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
    }
    {
      actions = [ (call "scene.turn_on" entities.scene.tvWatching { transition = 1; }) ];
      alias = "Media / Activate Movie scene on Table button Long press";
      conditions = [ (state entities.timer.movieSceneOfferWindow "active") ];
      description = "Long press activates the movie scene only while the offer window timer is running; otherwise the same press falls through to the light toggles.";
      triggers = [ (zha devices.roomTableButton "remote_button_long_press" "button") ];
    }
  ];
}
