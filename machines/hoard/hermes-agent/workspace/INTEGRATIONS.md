# Integration map

- Model: OpenAI Codex / ChatGPT subscription, authenticated with `hermes auth`.
- Telegram: owner DMs; separate BotFather token while OpenClaw runs. Groups
  are disabled. Use `/voice on` for voice-note replies.
- Speech: ElevenLabs Scribe v2 and Eleven v4. Set the existing ElevenLabs
  voice ID in `services.hermes-agent.settings.tts.elevenlabs.voice_id`.
- Home Assistant: `home-assistant` MCP is the Assist/exposed-entities API;
  `home-assistant-admin` is the privileged ha-mcp application.
- GitHub: the existing installed GitHub App, under Hermes' service account.
- OneDrive: the existing host sync, with read/write group access. Load its skill.
- Coding: persistent Claude Code ACP sessions with `hermes-claude-acp` and
  Codex ACP sessions with `hermes-codex-acp`, plus the native CLIs. Load the
  `claude-code-acp` and `codex-acp` fleet skills. These are independent of
  OpenClaw's session catalog and chat bindings.
- Memory: curated USER.md/MEMORY.md plus SQLite session search and learned skills.
- Scheduling: Hermes cron, using the hermes user's lingering systemd manager.
- API: authenticated OpenAI-compatible requests at loopback port 8642.
- Dashboard: loopback port 9119, accessed through an SSH tunnel.

The Home Assistant Voice PE broker remains attached to OpenClaw. Its session
observer, history, preflight and overflow protocol need a dedicated Hermes
adapter before any cutover. An OpenAI-compatible URL alone is insufficient.
