# OpenAI voice broker for the Voice PEs (packages/voice-broker).
# Setup steps that can't be declared here: scripts/voice-pe/runbook.md.
#
# Imperative, once, with the YubiKey or the op age key: the long-lived token
# of a dedicated Home Assistant user, with which the broker rings a speaker:
#   sops set <sopsFile> '["home-assistant-token"]' '"<token>"'
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.voice-broker;
  openclaw = config.my.openclaw;
  hermes = config.services.hermes-agent;
  hermesHome = "${hermes.stateDir}/.hermes";
  useOpenClaw = cfg.backend == "openclaw";
  hermesSocket = "/run/voice-broker-hermes/agent.sock";
  json = pkgs.formats.json { };
  voicePes = lib.filterAttrs (_: host: host.voiceArea != null) config.my.hosts;
  voicePeIps = map (host: host.lanIp) (lib.attrValues voicePes);
  nftables = config.networking.firewall.backend == "nftables";

  gated = cfg.mode == "gated";
  parallel = cfg.mode == "parallel";

  user = "voice-broker";
  stateDirectory = "voice-broker";
  recordingsDir = "${stateDirectory}/recordings";
  runtimeDirectory = "voice-broker";
  # the agent's way to open a conversation on a speaker
  callSocket = "/run/${runtimeDirectory}/call.sock";

  # ESPHome names a Voice PE after upstream's device name and the last three
  # bytes of its MAC (name_add_mac_suffix); Home Assistant exposes the
  # firmware's start_conversation action (scripts/voice-pe/voice-pe.yaml) under it.
  callAction =
    host:
    "esphome.home_assistant_voice_${lib.toLower (lib.concatStrings (lib.drop 3 (lib.splitString ":" host.mac)))}_start_conversation";

  # sopsFile keys, handed to the service as systemd credentials under the same names.
  credentialNames = [
    "openai-api-key"
    "device-token"
    "home-assistant-token"
  ]
  ++ lib.optional useOpenClaw openclawCredential
  ++ lib.optional jevClassifies openRouterKey;
  openclawCredential = "openclaw-secret";
  identityCredential = "identity";
  credential = name: "/run/credentials/voice-broker.service/${name}";
  # sops-nix secret names are host-global, so they carry the service name
  sopsName = name: "voice-broker/${name}";

  # Each routing provider's default model. gpt-6-luna is the only model Decisions takes so far;
  # typesafe/jev-1.13 is the Jev the frozen routing benchmarks measured (its dated endpoint
  # typesafe/jev-1.13-20260917 answered every call).
  routingModels = {
    decisions = "gpt-6-luna";
    jev = "typesafe/jev-1.13";
  };
  # The classifier in use: gating in gated mode, shadowing in parallel mode, or none.
  classifier =
    if gated then
      cfg.routing
    else if parallel && cfg.homeAssistant.shadow.enable then
      cfg.homeAssistant.shadow
    else
      null;
  # The OpenRouter key, only while Jev classifies: Decisions needs none.
  jevClassifies = classifier != null && classifier.provider == "jev";
  openRouterKey = "openrouter-api-key";
  # The JSON both classifier roles share (config.py _provider, _timeout).
  classifierSettings =
    c:
    {
      inherit (c) provider model;
      timeout_s = c.timeoutSeconds;
    }
    // lib.optionalAttrs (c.provider == "jev") {
      api_key_file = credential openRouterKey;
    };
  # Options of a classifier, gating or shadowing; `name` is its option path, for defaults and docs.
  classifierOptions = name: role: {
    provider = lib.mkOption {
      type = lib.types.enum (lib.attrNames routingModels);
      default = "decisions";
      description = ''
        The classifier (packages/voice-broker/src/voice_broker/routing.py)
        ${role}: `decisions`, OpenAI Decisions on the broker's OpenAI key; or
        `jev`, TypeSafe Jev through OpenRouter's System One API, on the
        OpenRouter key of `sopsFile`. One call per request either
        way; a failure never falls back to the other.
      '';
    };
    model = lib.mkOption {
      type = lib.types.str;
      default = routingModels.${(lib.getAttrFromPath name cfg).provider};
      defaultText = lib.literalMD "per provider: `gpt-6-luna` for decisions, `typesafe/jev-1.13` for jev";
      description = "The provider's model.";
    };
  };

  # Every consult is a turn of the main agent, the owner's assistant with its
  # own tools and memory: the owner's choice on 2026-10-17, over a separate,
  # restricted voice agent. The agent a /v1/responses request runs as is its
  # session key's `agent:<id>:` prefix (gateway/openai-compatible-agent-run.ts
  # at e178c39e), so both keys below are main's.
  mainAgent = "main";
  # Overflow sessions are agent:main:voice-overflow:<conversation>, one per
  # spoken conversation, used only while `overflow.enable` is on and the
  # broker's estimate says main's own session is too full for the consult
  # (packages/voice-broker/src/voice_broker/openclaw.py).
  overflowSessionPrefix = "agent:${mainAgent}:voice-overflow:";
  # The voice-call skill's word on overflow sessions, only while they can exist.
  overflowCallText = lib.optionalString (useOpenClaw && cfg.overflow.enable) (
    " When this session's context looks too full for it, the conversation goes"
    + " to a session of its own, which starts with this session's newest messages:"
    + " find it with sessions_list, searching ${overflowSessionPrefix}, the newest"
    + " one, and read its outcome with sessions_history."
  );
  voiceCallSkill = {
    description = "Call a speaker when the owner's answer is needed now; announcements need no reply.";
    text = ''
      When something needs the owner's answer now, call a speaker: a question
      blocking work, a choice, a confirmation, or news needing a reaction.
      A Home Assistant announcement is for a notice needing no reply; Telegram
      is for detail or anything that can wait. Calls interrupt the room, so
      reserve them for what matters now.

      The speakers, by area: ${
        lib.concatStringsSep ", " (map (host: host.voiceArea) (lib.attrValues voicePes))
      }.

          voice-broker-call --socket ${callSocket} <Area> "<opening>"

      The speaker chimes, says the opening, then listens. Replies reach the
      configured primary ${cfg.backend} conversation, with its tools and memory,
      not whichever unrelated session invoked the command.${overflowCallText}
      `started` means the speaker picked up; `failed: <reason>` means muted,
      busy or unreachable: use Telegram instead. Keep the opening to one or
      two spoken sentences. A successful call is not the owner's answer.
    '';
  };
in
{
  options.my.voice-broker = {
    enable = lib.mkEnableOption "the Voice PE broker";

    backend = lib.mkOption {
      type = lib.types.enum [
        "openclaw"
        "hermes"
      ];
      default = "openclaw";
      description = "The assistant carrying out delegated requests. This does not change the OpenAI Live voice or Home Assistant routing.";
    };

    hermes = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = cfg.backend == "hermes";
        defaultText = lib.literalExpression ''config.my.voice-broker.backend == "hermes"'';
        description = "Provision the local same-user Hermes gateway bridge. It may be enabled for verification while OpenClaw remains selected.";
      };
      sessionKey = lib.mkOption {
        type = lib.types.nullOr lib.types.nonEmptyStr;
        default = null;
        description = "Exact existing Hermes gateway routing key. Null selects the owner's Telegram DM using Hermes's telegram-owner-id credential; no ID is stored in the Nix store. Resolve the active canonical session afresh, including after /new and compression.";
      };
    };

    sopsFile = lib.mkOption {
      type = lib.types.path;
      description = "SOPS file holding openai-api-key, device-token and home-assistant-token; openclaw-secret only for OpenClaw, and openrouter-api-key only for Jev. Hermes uses a private local gateway ticket, not a copied API credential.";
    };

    homeAssistant.url = lib.mkOption {
      type = lib.types.str;
      description = "Base URL of the Home Assistant whose ESPHome actions ring the speakers.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 10310;
      description = "TCP port the Voice PEs connect to.";
    };

    recordings = {
      enable = lib.mkEnableOption ''
        recording every conversation's mic, echo reference and echo-cancelled
        audio, for tuning echo cancellation. That is household audio, so leave
        it off otherwise'';
      retention = lib.mkOption {
        type = lib.types.str;
        default = "7d";
        description = "systemd-tmpfiles age past which recordings are deleted, whether or not recording is on.";
      };
    };

    mode = lib.mkOption {
      type = lib.types.enum [
        "consult"
        "gated"
        "parallel"
      ];
      default = "consult";
      description = ''
        Who handles a delegated request, and who acts on the home
        (packages/voice-broker/src/voice_broker/config.py):
        - `consult`: the selected backend's primary agent answers every delegated request.
        - `gated`: a classifier (`routing`) sends each one to Home Assistant's
          conversation agent or to the selected backend, never both.
        - `parallel`: Home Assistant hears every utterance on its own
          pipeline (`homeAssistant.pipeline`) and alone acts on the home. No
          classifier gates anything. Refused for now: main answers delegated
          requests, and it can act on the home too.
        Gated and parallel need homeAssistantDeviceId on every Voice PE. In
        every mode a consult is a turn of main (`overflow` below).
      '';
    };

    routing = classifierOptions [ "routing" ] "that gates each delegated request in gated mode" // {
      timeoutSeconds = lib.mkOption {
        # The bounds are config.py's MIN_ROUTING_TIMEOUT_S and MAX_ROUTING_TIMEOUT_S, explained there.
        # A spoken request usually reaches the classifier cold, on a new connection, and 1.5 s ran out
        # with Decisions in production. 30 is a diagnostic allowance, not a latency target.
        type = lib.types.numbers.between 3 30;
        default = 4;
        description = "Classification time limit, connection setup included; past it nothing runs and the user is asked again.";
      };
      pipeline = lib.mkOption {
        type = lib.types.str;
        description = "ID of the Assist pipeline whose conversation agent home requests go to.";
      };
      pendingQuestionSeconds = lib.mkOption {
        type = lib.types.numbers.between 1 299;
        default = 60;
        description = "How long a question Home Assistant asked stays answerable; Home Assistant itself forgets after 5 minutes.";
      };
      settleSeconds = lib.mkOption {
        type = lib.types.numbers.between 0.05 1;
        default = 0.35;
        description = "Transcript quiet that marks a delegated request complete.";
      };
    };

    homeAssistant = {
      pipeline = lib.mkOption {
        type = lib.types.str;
        description = ''
          Parallel mode: name of the Assist pipeline that hears every
          utterance, beside GPT-Live, and alone acts on the home: its speech
          recognition and a home-only conversation agent. The broker resolves
          it by name at each conversation; scripts/voice-pe/runbook.md creates it.
        '';
      };
      readOnlyTools = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        # helpers/llm.py and the integrations' llm.py at 2026.10.1: the Assist API's tools that only read
        default = [
          "GetLiveContext"
          "GetDateTime"
          "get_events"
          "get_items"
          "search_media"
          "HassTimerStatus"
        ];
        description = "Names, after the last `__`, of the agent's tools that only read the home: using them alone is answering, not acting.";
      };
      nonHomeTools = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Names of exposed tools whose work is not about the home: their use is no evidence that the speech was a home request.";
      };
      bargeIn.enable = lib.mkEnableOption ''
        passing the user's speech over the assistant to Home Assistant once
        GPT-Live's transcript shows it: the mic audio is held while the
        assistant is audible and for up to 2 s after it. Otherwise that audio
        is dropped as echo, speech over the assistant with it'';
      shadow = {
        enable = lib.mkEnableOption ''
          classifying each delegation in parallel mode too, logged beside
          what Home Assistant actually did and never acted on. Each
          classification is a paid request'';
      }
      // classifierOptions [
        "homeAssistant"
        "shadow"
      ] "that only shadows each delegation in parallel mode"
      // {
        timeoutSeconds = lib.mkOption {
          # The bounds are config.py's MIN_ROUTING_TIMEOUT_S and MAX_ROUTING_TIMEOUT_S.
          type = lib.types.numbers.between 3 30;
          default = 4;
          description = "Time limit of a shadow classification; it only bounds a background request.";
        };
      };
    };

    overflow.enable = lib.mkEnableOption ''
      moving a spoken conversation to a session of its own (still main's
      agent, with main's tools) when the broker estimates that main's session
      is too full for its first consult. The estimate is advisory and not
      atomic: it reads main's last recorded usage and adds the consult's bytes
      and `marginTokens`, then sends the consult as a separate request. A
      Telegram turn can land in between, the gateway re-renders the prompt
      itself, and no gateway endpoint reserves room and submits in one step
      (OpenClaw e178c39e; workspace report
      voice-admission-critical-2026-10-17.md). So it can't guarantee that main
      is used only while it has room, nor that it moves only when main is
      really full. Also, on hoard on 2026-10-17 the HTTP history endpoint
      returned main's assistant `usage` without `contextUsage`, so every
      preflight would count as unknown and `whenUnknown` would decide alone
      (workspace report voice-morning-repair-rollout-2026-10-17.md). Off:
      every consult is a turn of main's own session and the gateway compacts
      it as it must. Kept off until the gateway admits a request atomically,
      or the owner accepts the approximation'';

    overflow.whenUnknown = lib.mkOption {
      type = lib.types.enum [
        "main"
        "overflow"
      ];
      default = "main";
      description = ''
        With `overflow.enable`: where a spoken conversation goes when main's
        context use can't be read before its first consult (the gateway
        unreachable, or no usage recorded yet). `main`: main's own session, the usual place, where the
        gateway compacts itself if it must; only evidence of a full session
        moves a conversation. `overflow`: a session of its own, keeping
        main's context untouched at the cost of main's context for the
        conversation.
      '';
    };

    overflow.marginTokens = lib.mkOption {
      type = lib.types.ints.unsigned;
      # Before each prompt the gateway adds 1.2 x (chars / 4) of the rendered
      # system prompt to the measured use (preemptive-compaction.ts,
      # context-token-pressure.ts at e178c39e), and no HTTP endpoint shows
      # that prompt's size. Main's was 39,320 characters on 2026-10-17
      # (its session's systemPromptReport), so 11,796 tokens; 16,000 leaves
      # room for it to grow by a third. Re-measure if skills or AGENTS.md grow.
      default = 16000;
      description = "Tokens counted on top of a consult before main's session counts as too full: what the gateway's own check adds that the broker can't read.";
    };

    overflow.handoffChars = lib.mkOption {
      type = lib.types.ints.between 0 8000;
      default = 2000;
      description = ''
        When main's session is too full for a spoken conversation, which then
        gets a session of its own: how much text of main's newest messages
        that session's first consult starts with. Bounded, so the handoff
        never brings main's context to the new session in full.
      '';
    };

    identityFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = if useOpenClaw then "${openclaw.workspace}/IDENTITY.md" else null;
      defaultText = lib.literalMD "OpenClaw: its workspace's `IDENTITY.md`; Hermes: null (the configured Live instructions)";
      description = ''
        The assistant's description of itself, read at each broker start to
        lead the Live instructions. The instructions stand alone while it is
        missing or empty, and with null.
      '';
    };

    settings = lib.mkOption {
      inherit (json) type;
      default = { };
      description = ''
        Broker configuration (packages/voice-broker/src/voice_broker/config.py):
        the Live session, the selected agent's consult instructions, how much of the
        agent's conversation the voice starts with, and the conversation
        timeouts. The listener, credentials, devices, recordings, calls, the
        mode's settings and the gateway's address and session come from this module.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = !useOpenClaw || (openclaw.enable && openclaw.responsesEndpoint.enable);
            message = "my.voice-broker.backend openclaw needs my.openclaw and its responsesEndpoint.";
          }
          {
            # Consults and overflow sessions are main's by their keys' prefix; the broker refuses a mismatch at start.
            assertion = !useOpenClaw || lib.hasPrefix "agent:${mainAgent}:" openclaw.mainSessionKey;
            message = "my.voice-broker consults main in my.openclaw.mainSessionKey, which names another agent.";
          }
          {
            assertion = useOpenClaw || cfg.hermes.enable;
            message = "my.voice-broker.backend hermes requires my.voice-broker.hermes.enable.";
          }
          {
            assertion = useOpenClaw || !cfg.overflow.enable;
            message = "my.voice-broker.overflow is OpenClaw-specific; Hermes uses its gateway's native session admission and compaction.";
          }
          {
            assertion =
              cfg.mode == "consult"
              || lib.all (host: host.homeAssistantDeviceId != null) (lib.attrValues voicePes);
            message = "my.voice-broker.mode ${cfg.mode} runs each Voice PE's home requests or speech as that device; set my.hosts.<name>.homeAssistantDeviceId for every one.";
          }
          {
            # Each provider's API takes only its own models; another's fails every request at runtime.
            assertion =
              classifier == null
              || (
                if classifier.provider == "jev" then
                  lib.hasPrefix "typesafe/jev-" classifier.model
                else
                  !lib.hasInfix "/" classifier.model
              );
            message = "my.voice-broker's classifier model ${toString (classifier.model or "")} is not a ${
              toString (classifier.provider or "")
            } model.";
          }
          {
            assertion = !cfg.homeAssistant.shadow.enable || parallel;
            message = "my.voice-broker.homeAssistant.shadow shadows parallel mode; gated mode's classifier is my.voice-broker.routing.";
          }
        ];

        my.voice-broker.settings = {
          listen_host = "0.0.0.0";
          listen_port = cfg.port;
          device_token_file = credential "device-token";
          openai_api_key_file = credential "openai-api-key";
          devices = lib.mapAttrsToList (
            name: host:
            {
              inherit name;
              address = host.lanIp;
              area = host.voiceArea;
              call_action = callAction host;
            }
            // lib.optionalAttrs (host.homeAssistantDeviceId != null) {
              home_assistant_device_id = host.homeAssistantDeviceId;
            }
          ) voicePes;
          recordings_dir = if cfg.recordings.enable then "/var/lib/${recordingsDir}" else null;
          agent = {
            provider = cfg.backend;
          }
          // (
            if useOpenClaw then
              {
                url = openclaw.localUrl;
                token_file = credential openclawCredential;
                # Every consult is a turn of main, in main's own session; with
                # overflow.enable, elsewhere when the estimate says it is too full.
                # null: the broker reads nothing before a consult (config.py).
                session_key = openclaw.mainSessionKey;
                agent = mainAgent;
                overflow =
                  if cfg.overflow.enable then
                    {
                      session_prefix = overflowSessionPrefix;
                      handoff_max_chars = cfg.overflow.handoffChars;
                      when_unknown = cfg.overflow.whenUnknown;
                      margin_tokens = cfg.overflow.marginTokens;
                    }
                  else
                    null;
              }
            else
              {
                socket = hermesSocket;
              }
          );
          calls = {
            socket = callSocket;
            home_assistant_url = cfg.homeAssistant.url;
            home_assistant_token_file = credential "home-assistant-token";
          };
          live = lib.optionalAttrs (cfg.identityFile != null) {
            identity_file = credential identityCredential;
          };
        };

        sops.secrets = lib.listToAttrs (
          map (
            name:
            lib.nameValuePair (sopsName name) {
              inherit (cfg) sopsFile;
              key = name;
            }
          ) credentialNames
        );

        # Static: the selected assistant reaches the call socket as a group member.
        users.users.${user} = {
          isSystemUser = true;
          group = user;
        };
        users.groups.${user} = { };
        systemd.services.voice-broker = {
          description = "OpenAI Live voice broker";
          wantedBy = [ "multi-user.target" ];
          wants = [ "network-online.target" ] ++ lib.optional (!useOpenClaw) "voice-broker-hermes.service";
          after = [ "network-online.target" ] ++ lib.optional (!useOpenClaw) "voice-broker-hermes.service";
          serviceConfig = {
            ExecStart = "${lib.getExe pkgs.voice-broker} --config ${json.generate "voice-broker.json" cfg.settings}";
            LoadCredential =
              map (name: "${name}:${config.sops.secrets.${sopsName name}.path}") credentialNames
              ++ lib.optional (cfg.identityFile != null) "${identityCredential}:${cfg.identityFile}";
            # the identity while identityFile is missing; a LoadCredential= that
            # finds no file falls back to it (systemd.exec(5), SetCredential=).
            # An escaped empty line: systemd drops an empty value, and the broker trims it.
            SetCredential = lib.optional (cfg.identityFile != null) "${identityCredential}:\\n";
            User = user;
            Group = user;
            StateDirectory = stateDirectory;
            # holds the call socket; group members reach it
            RuntimeDirectory = runtimeDirectory;
            RuntimeDirectoryMode = "0750";
            Restart = "on-failure";
            RestartSec = 5;
            # Audio processing is latency-sensitive; keep it ahead of batch work.
            Nice = -5;
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RemoveIPC = true;
            RestrictSUIDSGID = true;
            RestrictAddressFamilies = [
              "AF_INET"
              "AF_INET6"
              "AF_UNIX"
            ];
            RestrictNamespaces = true;
            LockPersonality = true;
            SystemCallArchitectures = "native";
          };
        };

        systemd.tmpfiles.settings.voice-broker."/var/lib/${recordingsDir}".e.age = cfg.recordings.retention;

        # Only the Voice PEs may open conversations: every one is billed to the OpenAI key.
        networking.firewall = {
          extraInputRules = lib.mkIf (nftables && voicePes != { }) ''
            ip saddr { ${lib.concatStringsSep ", " voicePeIps} } tcp dport ${toString cfg.port} accept
          '';
          extraCommands = lib.mkIf (!nftables && voicePes != { }) ''
            iptables -A nixos-fw -p tcp -s ${lib.concatStringsSep "," voicePeIps} --dport ${toString cfg.port} -j nixos-fw-accept
          '';
        };
      }

      (lib.mkIf useOpenClaw {
        users.users.${config.services.openclaw-gateway.user}.extraGroups = [ user ];
        my.openclaw.extraPackages = [ pkgs.voice-broker ];
        my.openclaw.skills.voice-call = voiceCallSkill;
      })

      (lib.mkIf (!useOpenClaw) {
        users.users.${hermes.user}.extraGroups = [ user ];
        services.hermes-agent.extraPackages = [ pkgs.voice-broker ];
        my.hermes-agent.skills.voice-call = voiceCallSkill;
      })

      (lib.mkIf cfg.hermes.enable {
        assertions = [
          {
            assertion = hermes.enable;
            message = "my.voice-broker.hermes.enable needs services.hermes-agent.enable on the same host.";
          }
          {
            assertion = cfg.hermes.sessionKey != null || config.my.hermes-agent.telegram.enable;
            message = "my.voice-broker.hermes needs an explicit sessionKey or the owner's enabled Hermes Telegram DM.";
          }
        ];
        systemd.services.voice-broker-hermes = {
          description = "Private voice broker bridge to the existing Hermes gateway";
          wantedBy = [ "multi-user.target" ];
          wants = [ "hermes-agent.service" ];
          after = [ "hermes-agent.service" ];
          environment.HERMES_HOME = hermesHome;
          serviceConfig = {
            # Use the gateway's exact SDK/interpreter. Same-UID tickets never
            # leave this bridge; it cannot start a replacement gateway.
            ExecStart = lib.escapeShellArgs (
              [
                "${hermes.package.hermesVenv}/bin/python"
                "-I"
                "${../../../packages/voice-broker/src/voice_broker/hermes_bridge.py}"
                "--socket"
                hermesSocket
                "--home"
                hermesHome
              ]
              ++ (
                if cfg.hermes.sessionKey != null then
                  [
                    "--session-key"
                    cfg.hermes.sessionKey
                  ]
                else
                  [
                    "--telegram-chat-id-file"
                    "/run/credentials/voice-broker-hermes.service/telegram-owner-id"
                  ]
              )
            );
            LoadCredential =
              lib.optional (cfg.hermes.sessionKey == null)
                "telegram-owner-id:${config.sops.secrets."hermes-agent/telegram-owner-id".path}";
            User = hermes.user;
            Group = user;
            RuntimeDirectory = "voice-broker-hermes";
            RuntimeDirectoryMode = "0750";
            UMask = "0007";
            Restart = "on-failure";
            RestartSec = 5;
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateTmp = true;
            PrivateDevices = true;
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictSUIDSGID = true;
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
            ];
            RestrictNamespaces = true;
            LockPersonality = true;
          };
        };
      })

      (lib.mkIf gated {
        my.voice-broker.settings.routing = classifierSettings cfg.routing // {
          inherit (cfg.routing) pipeline;
          pending_question_s = cfg.routing.pendingQuestionSeconds;
          settle_s = cfg.routing.settleSeconds;
        };
      })

      (lib.mkIf parallel {
        assertions = [
          {
            # Parallel mode makes Home Assistant the home's only actor. Consults
            # are main's turns, and main has Home Assistant's action tools, so a
            # consult on speech Home Assistant also heard could act a second
            # time. Neither the request's own tools nor tool_choice narrow the
            # agent's native or MCP tools (openclaw.py), and at OpenClaw
            # e178c39e no trusted, per-request narrowing of main's tools exists
            # for agent:main:main, a session Telegram shares (workspace report
            # voice-main-overflow-session-2026-10-17.md). Until one does, and is
            # verified, parallel mode is refused rather than run with two actors.
            assertion = false;
            message = "my.voice-broker.mode parallel needs consults that can't act on the home; the selected primary agent can. Use gated.";
          }
        ];

        my.voice-broker.settings.home_assistant = {
          inherit (cfg.homeAssistant) pipeline;
          read_only_tools = cfg.homeAssistant.readOnlyTools;
          non_home_tools = cfg.homeAssistant.nonHomeTools;
          barge_in = cfg.homeAssistant.bargeIn.enable;
          shadow = lib.mkIf cfg.homeAssistant.shadow.enable (classifierSettings cfg.homeAssistant.shadow);
        };
      })
    ]
  );
}
