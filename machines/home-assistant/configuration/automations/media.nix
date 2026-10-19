{ haDevices, ... }:
{
  services.home-assistant.config.automation = [
    {
      id = "1741877005352";
      alias = "Media / Turn off soundbar when TV turns off";
      triggers = [
        {
          device_id = haDevices.tv;
          domain = "media_player";
          entity_id = "7dd4bf5f56627ca44da4c7f5250ada00";
          type = "turned_off";
          trigger = "device";
        }
      ];
      conditions = [
        {
          condition = "or";
          conditions = [
            {
              condition = "state";
              entity_id = "media_player.soundbar";
              attribute = "source";
              state = "wifi";
            }
            {
              condition = "state";
              entity_id = "media_player.soundbar";
              attribute = "source";
              state = "HDMI1";
            }
            {
              condition = "state";
              entity_id = "media_player.soundbar";
              attribute = "source";
              state = "HDMI2";
            }
          ];
        }
      ];
      actions = [
        {
          action = "media_player.turn_off";
          data = { };
          target = {
            entity_id = "media_player.soundbar";
          };
        }
      ];
      mode = "single";
      initial_state = false;
    }
    {
      id = "1741995459539";
      alias = "Media / Goodnight";
      triggers = [
        {
          trigger = "conversation";
          command = [
            "Goodnight"
            "Good night"
          ];
          alias = "\"Goodnight\"";
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "scene.turn_on";
          data = {
            transition = 1;
          };
          target = {
            entity_id = "scene.night";
          };
        }
        {
          set_conversation_response = "Goodnight!";
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1743802438397";
      alias = "Media / Turn on download throttling when Plex is streaming";
      triggers = [
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.hoard"
          ];
          above = 0;
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "switch.turn_on";
          data = { };
          target = {
            entity_id = "switch.qbittorrent_alternative_speed";
          };
          alias = "qBittorrent: Enable alternative speed";
        }
        {
          action = "button.press";
          data = { };
          target = {
            entity_id = "button.sabnzbd_pause";
          };
          enabled = true;
          alias = "sabnzbd: Pause";
        }
        {
          action = "nzbget.pause";
          data = { };
          enabled = false;
          alias = "NZBGet: Pause";
        }
        {
          action = "nzbget.set_speed";
          data = {
            speed = 10000;
          };
          alias = "NZBGet: Limit speed";
          enabled = false;
        }
      ];
      mode = "single";
      initial_state = false;
    }
    {
      id = "1743802518371";
      alias = "Media / Turn off download throttling if Plex is not streaming";
      triggers = [
        {
          trigger = "numeric_state";
          entity_id = [
            "sensor.hoard"
          ];
          for = {
            hours = 0;
            minutes = 0;
            seconds = 30;
          };
          below = 1;
        }
      ];
      conditions = [ ];
      actions = [
        {
          action = "switch.turn_off";
          data = { };
          target = {
            entity_id = "switch.qbittorrent_alternative_speed";
          };
          alias = "qBittorrent: Disable alternative speed";
        }
        {
          action = "button.press";
          data = { };
          target = {
            entity_id = "button.sabnzbd_resume";
          };
          enabled = true;
          alias = "sabnzbd: Resume";
        }
        {
          action = "nzbget.resume";
          data = { };
          enabled = false;
          alias = "NZBGet: Resume";
        }
        {
          action = "nzbget.set_speed";
          data = {
            speed = 0;
          };
          enabled = false;
          alias = "NZBGet: Disable speed limit";
        }
      ];
      mode = "single";
      initial_state = false;
    }
    {
      id = "1744026803586";
      alias = "Media / Ask to activate Movie scene";
      description = "After dark, when Plex starts a fresh playback, offer the movie scene and open a 10s window in which a long press activates it.";
      triggers = [
        {
          entity_id = [
            "media_player.plex_tv"
          ];
          to = "playing";
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          trigger = "state";
          from = "idle";
          note = "from: is listed explicitly so resuming from paused does not re-offer.";
        }
        {
          entity_id = [
            "media_player.plex_tv"
          ];
          to = "playing";
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          trigger = "state";
          from = "standby";
        }
        {
          entity_id = [
            "media_player.plex_tv"
          ];
          to = "playing";
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          trigger = "state";
          from = "unknown";
        }
        {
          entity_id = [
            "media_player.plex_tv"
          ];
          to = "playing";
          for = {
            hours = 0;
            minutes = 0;
            seconds = 10;
          };
          trigger = "state";
          from = "unavailable";
        }
      ];
      conditions = [
        {
          condition = "sun";
          after = "sunset";
          before = "sunrise";
        }
        {
          condition = "state";
          entity_id = "timer.movie_scene_cooldown";
          state = "idle";
          note = "Cooldown is a restore-enabled timer, so it keeps counting across a restart and always ends.";
        }
      ];
      actions = [
        {
          action = "timer.start";
          data = { };
          target = {
            entity_id = "timer.movie_scene_cooldown";
          };
        }
        {
          action = "assist_satellite.announce";
          data = {
            message = "Hold the table button to activate the movie scene";
            preannounce = true;
          };
          target = {
            area_id = "room";
          };
          note = "Blocks until the message has been spoken.";
        }
        {
          action = "timer.start";
          data = { };
          target = {
            entity_id = "timer.movie_scene_offer_window";
          };
          note = "Started after the announcement, so the 10s window runs from when the message ends.";
        }
      ];
      mode = "single";
      initial_state = true;
    }
    {
      id = "1744987485407";
      alias = "Media / Activate Movie scene on Table button Long press";
      description = "Long press activates the movie scene only while the offer window timer is running; otherwise the same press falls through to the light toggles.";
      triggers = [
        {
          device_id = haDevices.roomTableButton;
          domain = "zha";
          type = "remote_button_long_press";
          subtype = "button";
          trigger = "device";
        }
      ];
      conditions = [
        {
          condition = "state";
          entity_id = "timer.movie_scene_offer_window";
          state = "active";
          note = "The automation stays enabled; the timer is what arms it. The light-toggle automations gate on the inverse of this timer.";
        }
      ];
      actions = [
        {
          action = "scene.turn_on";
          data = {
            transition = 1;
          };
          target = {
            entity_id = "scene.tv_watching";
          };
        }
      ];
      mode = "single";
      initial_state = true;
    }
  ];
}
