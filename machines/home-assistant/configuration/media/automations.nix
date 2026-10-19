{ ha, ... }:
let
  inherit (ha)
    templates
    entities
    devices
    call
    state
    announce
    longPress
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
    {
      alias = "Voice / Add media using Assist";
      triggers = [
        {
          command = [
            "(download|add|send) [the] (movie|film) {movie_title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
            "(download|add|send) [the] [tv|television] (show|series) {show_title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
            "(download|add) [the] (movie|film) {movie_title}"
            "(download|add) [the] [tv|television] (show|series) {show_title}"
            "(download|add|send) [the] {title} (on|to|in|into|2) [my|our|the] [media] ((plex|duplex) [library|collection]|library|collection|watch list|watchlist)"
          ];
          trigger = "conversation";
        }
      ];
      actions =
        ha.orderedVariables [
          {
            inherit (templates) slots;
          }
          {
            inherit (templates) raw_title;
          }
          {
            inherit (templates) raw_type;
          }
          {
            inherit (templates) media_kind;
          }
          {
            inherit (templates) clean_title;
          }
        ]
        ++ [
          {
            alias = "Stop if this is not a movie or show";
            "if" = [
              {
                alias = "The title is a list or calendar entry";
                condition = "template";
                value_template = templates.reject_media;
              }
            ];
            "then" = [
              {
                alias = "Say nothing was added";
                set_conversation_response = "That sounds like a list or calendar item, not a movie or show, so I didn't add anything.";
              }
              { stop = "Not a media request"; }
            ];
          }
          {
            alias = "Classify media kind via LLM if necessary";
            "if" = [
              {
                alias = "media_kind is unknown";
                condition = "template";
                value_template = templates.unknown_media;
              }
            ];
            "then" = [
              {
                action = "conversation.process";
                alias = "Ask LLM to classify media";
                data = {
                  agent_id = entities.conversation.chatgpt2;
                  text = templates.classifier_prompt;
                };
                response_variable = "llm_kind";
              }
              {
                alias = "set classified media_kind variable";
                variables = {
                  media_kind = templates.classified_media;
                };
              }
            ];
          }
          {
            alias = "media_kind is STILL unknown";
            "if" = [
              {
                alias = "media_kind is unknown";
                condition = "template";
                value_template = templates.unknown_media;
              }
            ];
            "then" = [
              {
                alias = "Set response with error message";
                set_conversation_response = templates.unsure_media;
              }
              { stop = "Unknown media kind"; }
            ];
          }
          {
            alias = "Choose between movie or show";
            choose = [
              {
                alias = "Movie";
                conditions = [
                  {
                    alias = "media_kind is movie";
                    condition = "template";
                    value_template = templates.movie_media;
                  }
                ];
                sequence = [
                  {
                    action = "hassarr.add_overseerr_movie";
                    data = {
                      title = templates.title_case;
                    };
                  }
                ];
              }
              {
                alias = "Show";
                conditions = [
                  {
                    alias = "media_kind is show";
                    condition = "template";
                    value_template = templates.show_media;
                  }
                ];
                sequence = [
                  {
                    action = "hassarr.add_overseerr_tv_show";
                    data = {
                      title = templates.title_case;
                    };
                  }
                ];
              }
            ];
          }
          {
            action = "ai_task.generate_data";
            alias = "Ask for a joke";
            data = {
              entity_id = entities.ai_task.openaiAiTask;
              instructions = templates.confirmation_prompt;
              task_name = "Media added confirmation";
            };
            response_variable = "witty_remark";
          }
          {
            alias = "Set success response";
            set_conversation_response = templates.media_confirmation;
          }
        ];
    }
  ];
}
