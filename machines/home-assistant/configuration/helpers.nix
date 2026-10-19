{
  services.home-assistant.config = {
    input_boolean = {
      home_assistant_fully_loaded = {
        name = "Home Assistant Fully Loaded";
        icon = "mdi:home-assistant";
      };
    };
    input_button = {
      reaper_windows = {
        name = "Reaper Windows";
        icon = "mdi:microsoft-windows";
      };
    };
    timer = {
      movie_scene_offer_window = {
        name = "Movie scene offer window";
        icon = "mdi:gesture-tap-hold";
        duration = "0:00:10";
        restore = true;
      };
      movie_scene_cooldown = {
        name = "Movie scene cooldown";
        icon = "mdi:timer-cog-outline";
        duration = "3:00:00";
        restore = true;
      };
    };
  };
}
