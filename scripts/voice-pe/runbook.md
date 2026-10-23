# Voice PE runbook

The Voice PEs (the hosts with a `voiceArea` in `modules/common/hosts.nix`) run
one firmware, `voice-pe.yaml`: the stock Home
Assistant Voice firmware with per-wake-word routing. **Okay Nabu** uses
the stock Assist path, still switched between pipelines by the Assistant
selects. **Hey Jarvis** hands the conversation to the
voice broker on hoard (`machines/hoard/voice-broker.nix`), which
runs it on GPT-Live. GPT-Live listens while it speaks and decides itself when
to answer, yield or keep going. Work it delegates goes to OpenClaw's main
agent on hoard (`machines/hoard/openclaw.nix`), in one session every PE
shares. A request that names no place is about the PE's `voiceArea`.

While a broker conversation runs, the wake word or a press of the center
button ends it.
A Home Assistant announcement that arrives mid-conversation shares the
speaker with it.

## One-time setup

1. In Home Assistant, add the **Model Context Protocol Server** integration
   with the Assist API. OpenClaw controls the entities exposed to Assist
   (Settings → Voice assistants → Expose) through it, as its own Home
   Assistant user (`home-assistant-token` in `secrets/hoard/openclaw.yaml`).
2. Fill the placeholder in the broker's secrets. The device token is already
   generated:

   ```sh
   nix develop -c sops secrets/hoard/voice-broker.yaml
   ```

   - `openai-api-key`: an OpenAI API key with Live access

3. Deploy harbor (static lease) and hoard (broker):

   ```sh
   nixos-rebuild switch --flake .#harbor --target-host harbor --sudo
   nixos-rebuild switch --flake .#hoard --target-host hoard --sudo
   ```

   Restart each Voice PE from Home Assistant so it picks up its static lease;
   the broker only accepts those addresses. Home Assistant finds them again
   through zeroconf.

## Offline Nix firmware

Build on the configured reaper builder with zero local jobs to keep firmware
compilation off hoard.

```sh
sudo -n nix build .#voice-pe-firmware --max-jobs 0 --cores 8 --no-link --print-out-paths -L
```

Outputs: `firmware.bin` (OTA application), bootloader, partition table, ELF, size
report, checksums and offline-build evidence. Ordinary sandboxed derivation: no
network routes, IDF manager disabled, dependencies vendored and SHA-256 locked.
Changes to YAML/component source automatically regenerate the Nix project.

All inputs are reconstructible from repository source and public hash-pinned fetches.
`public-inputs.lock.json` pins both upstream commits, 12 IDF managed component
archives and three PlatformIO libraries. `assets.lock.json` pins five model
manifests/models and XMOS firmware; sounds come from the immutable external
upstream commit. `python-inputs.lock.json` pins the IDF build-time Python closure
(wheels, plus pure-Python esptool source). Native wheel ELF dependencies are
patched with Nix libraries; downloads occur only in fixed-output fetch derivations.

`esphome.nix` pins the ESPHome 2026.8.0 generator source and hash independently
of the fleet's rolling ESPHome package; update it together with the firmware's
SDK and public input locks. `project.nix` starts with a new HOME and empty
project, runs ESPHome 2026.8.0 code generation offline, redirects only declared
pinned library/XMOS sources, and fails unexpected downloads. Firmware
compilation uses two CMake configure
passes: the first discovers built-in IDF components, the second supplies their
REQUIRES. Neither step consumes an old ESPHome build directory. Build metadata
uses a fixed release epoch, independent of wall-clock time.

The package builds from source and pinned public inputs without imported store
snapshots, local caches, or GC roots.

To update, change the release/commit/archive/PyPI hash locks deliberately, review
localization in `reconstruct.py`, then build the firmware and the `voice-pe` check.
Never add Wi-Fi/API/broker secrets as Nix attributes or files.

## Explicit flashing (never performed by a build)

After separate deployment authorization, choose one already-adopted PE:

```sh
nix run "path:$PWD#flash-voice-pe" -- --confirm-flash /nix/store/…-voice-pe-firmware-… kitchen.glib.sh
```

Validates checksums and uploads a prebuilt OTA application only. Never decrypts
secrets, compiles, changes partitions, or defaults to all devices. Wi-Fi/API keys
survive OTA in NVS. Factory/USB recovery is separate. Wrapper assumes the existing
stock OTA endpoint has no password.

## Runtime broker credential

Stop conversations, then provision from a private terminal:

```sh
nix run "path:$PWD#provision-voice-pe" -- kitchen.glib.sh
```

Private prompts for existing API Noise key and broker token (empty clears). No
secrets enter Nix inputs/store, argv, source or shell history. Write-only action
reports sent, not accepted: verify a new Live conversation separately. Updates
are rejected while busy, without a nonzero authenticated Noise key, or containing
overlong/control/whitespace characters. Token persists in preferences/NVS. Failed
persistence leaves the in-memory active token unchanged. I/O owner rebuilds
authorization under a mutex per connection. Missing/cleared token uses Assist.

Package removes plaintext API support and compiles INFO logging: protobuf dumps
cannot expose action arguments. Factory-reset devices need their Noise key first;
all-zero provisioning key cannot provision broker credentials. Custom-action
authorization snapshots whether a nonzero key existed at connection creation: an
onboarding connection cannot acquire action rights after another client adopts
the device. NVS is not encrypted
at rest: physical flash access can recover secrets. Existing broker transport is
`ws://` on trusted LAN, not TLS; never expose it on an untrusted network.

## Using it

Say **Okay Nabu** for normal Assist, or **Hey Jarvis** for Live. Both models
are enabled on HA client connection (also after reboot), overriding saved disabled
states. Disable them in HA only until the next HA reconnect.
Mycroft, if manually enabled, retains normal Assist. Watch the broker with
`ssh hoard journalctl -fu voice-broker`.

### Verified upstream wake words

The pinned [Voice PE 26.9.0 firmware](https://github.com/esphome/home-assistant-voice-pe/blob/26.9.0/home-assistant-voice.yaml)
already includes `okay_nabu` and `hey_jarvis`. Their model manifests report
**Okay Nabu** (okay_nabu_20241226.3 release) and **Hey Jarvis** (ESPHome
micro-wake-word-models v2). These are full phrases, not bare Nabu/Jarvis.
The ESPHome `on_wake_word_detected` argument is the manifest `wake_word` string;
routing compares it with `Hey Jarvis`. Both model IDs and the
`micro_wake_word.enable_model` actions were validated with ESPHome 2026.8.0.

### Startup fallback (no replay)

The device streams the microphone from connection; the broker holds that audio
until its model session opens, then emits the first `phase: listening`
(readiness). Connection refusal, authentication failure, END/disconnect before
readiness, or a 10-second combined connection/model-startup timeout invokes
normal `voice_assistant.start` once. A component allocation failure or a missing
token falls back immediately. Generation checks ignore late events and stale
queued opens; no reconnect or backend retry loop is used.

No audio/transcript is replayed: speech held for a failed startup is dropped, so
repeat the command at the Assist listening cue.
After readiness, failures end Live without automatic Assist fallback, because
tools may already have acted. Normal completion and button/wake cancellation
never fall back. The stock button/timer/announcement behavior is retained.

Neither path sets a pipeline ID or changes HA Assistant selects. Read-only
inspection of `automation.switch_to_reaper_assistant` and
`automation.change_voice_assistant_to_remote` confirmed they select Reaper or
Remote for kitchen/room according to Ollama/STT/TTS availability. Those current
selections are honored for Nabu and fallback. No HA automation changes or broker
deployment are required.

### Verification

ESPHome config/code generation runs without secrets. Never compile firmware on hoard.
The `voice-pe` flake check runs the component's startup fallback and token rules
(`session.cpp`, `credential.h`) on the host.

With authorization, flash one named PE first, then check:

- Nabu honors both Reaper and Remote Assistant selection.
- Jarvis starts Live; either wake word and center button cancel it.
- Unreachable broker/auth rejection/Live startup refusal or stall falls back
  exactly once; repeat the command at the normal Assist listening cue.
- Cancel during connection or model startup; wait >10 seconds: no fallback.
- Drop an active Live session after a harmless tool call: no Assist replay.
- Mute, timer cancel, announcement cancel and stock button gestures still work.

Before a rebuild/deployment that interrupts voice, give the user a spoken
response and obtain deployment authorization. Once the single-PE smoke tests
pass, flash other PEs. This firmware change needs no NixOS rebuild.

## Home Assistant's home-only pipeline

Hoard uses `my.voice-broker.mode = "gated"`: its classifier routes each request
to Home Assistant or OpenClaw. The module refuses `"parallel"`, because OpenClaw
consults can also act on the home (see "Consults and main's session" below).

The home-only integration has a dedicated OpenAI agent and Assist pipeline,
named by `my.voice-broker.homeAssistant.pipeline`. The setup helper creates
these independently of the broker mode. It copies speech recognition and
language from **Remote** and gives the pipeline its own home-only prompt.

From hoard, with the broker's Home Assistant token on stdin (never printed):

```sh
sudo cat /run/secrets/voice-broker/home-assistant-token |
  $(dirname "$(readlink -f "$(command -v voice-broker)")")/voice-broker-ha-setup \
    --url http://homeassistant.glib.sh:8123 \
    --backup-dir /var/lib/openclaw/workspace/backups/ha-voice-setup
```

Run it without `--apply` first. That run only reads Home Assistant, writes a
0600 backup of the pipelines and agents, and prints what it would create. Then
run it again with `--apply`. It only ever creates, and is safe to re-run:
- It copies speech recognition and language from "Remote" unchanged.
- It sets no TTS and does not touch the preferred pipeline.
- It never changes or replaces an existing agent, pipeline or exposure.
- If something differs, it stops and says what.

Check the result in Settings → Voice assistants → "Voice broker home".

Any Home Assistant admin's token works on stdin; the broker's file is root's.
The declared home-only pipeline is **Voice broker home**, using the agent
`conversation.voice_broker_home`. Hoard runs in gated mode; parallel mode is
unavailable while OpenClaw consults can also act on the home.

Exposure to Assist is set per assistant, not per agent. So the home-only agent can
also see the exposed non-home scripts, `ask_gpt` and the weather script. Its
prompt tells it not to use them for non-home questions. If it does, the broker
counts that as non-home work (`nonHomeTools`), never as home evidence.
Unexposing them would also take them from "Remote", so that is left to the
owner. A narrower tool scope for the agent alone does not exist: its only
selectable LLM API is "Assist".

To remove the helper-created integration, keep the broker in `"gated"` mode,
then delete the **Voice broker home** pipeline and its agent under the OpenAI
Conversation integration.

## Consults and main's session

Every consult is a turn of OpenClaw's main agent, in main's own session,
`agent:main:main`, the one Telegram uses. So a spoken conversation and
Telegram share one context, and the gateway compacts that session as it must.

The overflow below is **off by default** (`my.voice-broker.overflow.enable`)
and off on hoard. Turning it on needs the owner's approval of the
approximation. The estimate is advisory and not atomic: it reads main's last
recorded usage, then sends the consult as a separate request. A Telegram turn
can land in between, and the gateway renders the real prompt only at that
point. No gateway endpoint reserves room and submits in one step. So the estimate
can't guarantee that main is used only while it has room, nor that a conversation
moves only when main is really full. A strict
version needs admission inside the gateway. Missing `contextUsage` in a history
response makes the preflight's estimate unknown.

With the overflow on, a conversation moves when the estimate finds main's
session has no room for it. Before its first consult the broker reads, from
the running gateway, main's context budget and use (`openclaw.py` `preflight`):
- the budget: the `sessions_list` tool's row for main over `/tools/invoke`;
- the use: the newest model call's tokens, from main's transcript.

The broker adds the consult's bytes and `overflow.marginTokens`, which stands
for the rendered system prompt the gateway estimates again before each prompt.
If that would take main past the point where the gateway compacts first (its
window less the reserve), the conversation gets a session of its own, `agent:main:voice-overflow:<speaker>-<id>`. That session is main's agent
too, with a bounded handoff of main's newest messages
(`my.voice-broker.overflow.handoffChars`).

The choice is made once per conversation, and its follow-ups stay with it. A
consult is never resent elsewhere after its request, even one that failed or
timed out, because it may have acted. The next conversation is placed afresh.
When the use can't be read or bounded, `overflow.whenUnknown` decides, and
the journal says `context use unknown (<why>)`. That covers a failed read, an
unmeasured newest call, no call among the 20 newest messages, and a newer
message shown cut or with an image. The journal logs each placement as
`consults in <session>: <used> + <request> of <threshold> tokens`, numbers only.

To read main's numbers by hand, read-only:

```sh
openclaw gateway call sessions.list --params '{"agentId":"main","search":"agent:main:main","limit":5}' --json |
  jq -c '.sessions[] | select(.key=="agent:main:main") | {totalTokens, contextTokens, contextBudgetStatus}'
```

Use the running gateway's view. `openclaw sessions --json` reads the store in
its own process, which can lack the model's window and show a 200000 default.

## Recording conversations

To check the echo cancellation against what happened in the room:

1. Set `recordings.enable = true` in `machines/hoard/voice-broker.nix` and
   deploy hoard.
2. Have a few conversations: talk over replies, and also let replies play out
   while the room is noisy (music, dishes).
3. Each conversation leaves `<stamp>-<pe>.wav` in
   `/var/lib/voice-broker/recordings/`: 16 kHz with three channels,
   the raw mic, what the speaker played (aligned to the mic), and the
   echo-cancelled mic.
4. Set `recordings.enable = false`, delete the recordings, deploy.

## Undo

Use **Okay Nabu** for Home Assistant. Disable Jarvis in HA to avoid Live until
the next HA reconnect. To go back to the stock firmware,
flash it from https://esphome.github.io/home-assistant-voice-pe/ over USB.
