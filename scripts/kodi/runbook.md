# Kodi runbook

CoreELEC box, reached as `ssh kodi`. Skin is Bingie (`skin.bingie`), library
comes from Plex on hoard through PlexKodiConnect (PKC). `/storage/.config`
survives CoreELEC updates; `/storage/.config/system.d` holds user systemd
units.

## Customizations

Kodi overwrites an addon's directory on every update, so `kodi-customize.sh`
reapplies these at boot and after each Bingie, Bingie Widgets or PKC update:

- Kodi's settings from the table in `kodi-customize.sh`, each with its reason:
  player-led Dolby Vision tuned for the S95C,
  and subtitles at a fixed spot in the bottom letterbox bar, the same in every
  display mode
- InfoTagger 0.0.9, fetched by `deploy.sh` at its pinned commit, and the pin
  that keeps Skin Shortcuts at 2.1.0
- hides the Bingie profile switcher at the top of the side menu
- installs every file in `skin-overrides/` into the skin, currently a
  Netflix-style PKC skip intro/credits button
- shows the Dolby Vision profile and HDR10+ from Plex in Bingie's HDR badge,
  e.g. "DV P8.1 · HDR10+" (`snippets/`)
- adds an **HDR10+ mapping** row at the top of the OSD's **Video settings**,
  showing the selected mode and actual playback processing type. The row stays
  visible and explains when HDR10+ is not detected. Hybrid files offer **Native HDR10+**,
  **Original DoVi**, and **HDR10+ mapped to DoVi**; HDR10+-only files offer the
  two applicable modes. A change stops and reopens the video at the
  current position, restoring pause, audio and subtitle selection. The S95C
  receives player-led DoVi as HDR10. The choice persists in Kodi's settings
  across boots, deployments and add-on updates
- keeps an in-progress item's rating, year, HDR badges and plot on screen, with
  the progress bar under them
- lists files without subtitles in Bingie's widgets, e.g. Continue Watching
  (`snippets/`)

Deploy from eve:

```sh
scripts/kodi/deploy.sh
```

Skin edits reload automatically once playback stops; deployments and add-on
updates leave the current video running. Until then the previous layout stays
loaded. Kodi's Video settings opens with its usual first setting focused;
press Up to reach the HDR10+ mapping row above it.

A running Kodi takes setting changes at once; the subtitle position per
display mode, InfoTagger and the Skin Shortcuts pin land at the next boot
(`ssh kodi reboot`). The table is the source of truth: a setting changed in
Kodi's menus goes back to the table's value whenever the script runs. The OSD's
HDR10+ conversion, dual-format priority and conversion preference are excluded
from the table so the button's choice survives. After a
PKC patch change, restart Kodi so PKC loads it
(`ssh kodi systemctl restart kodi`).
Library items get new HDR details when PKC next syncs them; to rewrite all of
them, run PKC's repair sync:
`ssh kodi 'kodi-send --action="RunPlugin(plugin://plugin.video.plexkodiconnect/?mode=repair)"'`.

Removing a file from `skin-overrides/` does not remove the installed copy from
the skin; delete it from `skin.bingie/1080i` as well.

If an addon release moves something a patch anchors on, the script logs
`anchor not found` and leaves that file untouched; a setting that Kodi or
CoreELEC renames is logged too: `ssh kodi journalctl -t kodi-customize`.

To undo: disable both units, delete them and `/storage/.config/kodi-customize`,
then reinstall Bingie, Bingie Widgets and PKC from their repositories to
restore the original files. The settings stay until changed in Kodi.

## Follow-up: per-video HDR10+ mapping

The current HDR10+ picker changes CPM's global settings. Make its choice
persist per video file, like Kodi's other Video settings, through a Kodi
source patch in `cpm/patches/kodi/` and a rebuild.

Desired behavior:

- Save **Native HDR10+**, **Original DoVi**, or **HDR10+ mapped to DoVi** for
  each file. Offer **Use global default** to clear the override; HDR10+-only
  files expose only their applicable modes.
- Load the saved mode before HDR policy selection and decoder initialization,
  so replaying or resuming a file starts in the right mode without a second
  playback start from a background script.
- Resolve the override for the current player without changing global HDR
  settings or another video's preference. Files without overrides retain the
  global default, including existing files after a database migration.
- Keep the choice and actual processing status in the OSD's Video settings.
  Changing mode during playback should preserve position, pause state, audio
  and subtitles if the decoder must reopen.

Implementation scope: extend `CVideoSettings` and its comparison/default
handling, add database persistence and migration in `CVideoDatabase`, expose
the mode in `CGUIDialogVideoSettings`, and pass the resolved choice into CPM's
Amlogic HDR policy before opening the decoder. Replace the global-setting
writes in `kodi-hdr10plus.py` and the custom skin row with the native setting
when that support lands. Keep build patches and deployment idempotent in this
repo.

Verify that two files remember different modes across Kodi restarts, clearing
an override restores the global default, every applicable mode transition
works in both directions, and switching between files leaves HDR/SDR colors,
playback state and unrelated video settings correct.

## CoreELEC build

The box runs CPM's CoreELEC fork with Kodi 22, built from source. CPM's Kodi
does player-led Dolby Vision: the box runs the Dolby Vision processing and
sends HDR10, which is how the Samsung S95C, a TV without Dolby Vision, shows
profile 7 FEL. CPM publishes no builds.

`cpm/build.sh` pins `cpm-code/CoreELEC`, which in turn pins its Kodi
(`cpm-code/xbmc`) and kernel (`cpm-code/linux-amlogic`), and adds the patches
in `cpm/patches/`, one directory per package:

- `kodi/local-demux-replay-seek.patch` drops the packets the startup probes
  queue when playback seeks, so a resumed movie starts with audio and picture
  in sync
- `kodi/local-window-close-message-flags.patch` reads a cross-thread window
  close's force and sound flags from the field the sender fills, so a forced
  close requested off the main thread completes
- `kodi/local-render-osd-on-main-thread.patch` keeps the OSD and seek bar on
  Kodi's main thread. CPM's overlay worker renders them from a second GL
  context, and Kodi's GUI renderer keeps its shaders, matrices and viewport as
  state both contexts share, so the worker's output comes out invisible or
  mirrored
- `kodi/local-aml-decoder-timeout-paused.patch` suspends the Amlogic
  decoder's 6 s stall timeout while playback is paused. Paused playback holds the
  decoder's output buffers, and the timeout restarts the decoder at a later
  keyframe, so a pause after a frame step keeps the picture in sync with the
  audio
- `linux/local-amlvideo-qbuf-held-index.patch` makes the video driver move
  frames to the screen on a release only when it holds the released frame. A
  seek's decoder reset discards the frames the driver holds, and Kodi releases
  its pre-seek frames after the reset, so each frame after a seek reaches the
  screen at its own release
- `linux/local-dv-hdmi-pkt-cache-reset.patch` clears the Dolby Vision driver's
  record of the HDMI packets it sent when Dolby Vision turns off. The driver
  skips a packet identical to the recorded one, and other drivers set the
  packets while Dolby Vision is off, so each Dolby Vision playback sends its
  HDR10 and BT.2020 signalling
- `linux/local-dv-ll-brightness-reset.patch` clears the Dolby Vision brightness
  adjustment when Dolby Vision turns off. The adjustment sits in the video
  post-processing every output passes through, so HDR10, HDR10+ and SDR
  playback that follows Dolby Vision keeps the source's black level

Build on reaper. The first build takes a few hours; a Kodi-only change takes
minutes:

```sh
scripts/kodi/cpm/build.sh > ~/build/cpm-build.log 2>&1
```

Install from reaper. The script backs the box up to `~/build/kodi-backup-<time>`
first, then reboots it into the update:

```sh
scripts/kodi/cpm/flash.sh ~/build/cpm-coreelec/target/CoreELEC-Amlogic-ng.aarch64-<version>.tar
```

`ssh kodi grep VERSION= /etc/os-release` shows the running build. To roll back
(untested): unpack the backup's `flash.tar` over `/flash` after
`mount -o remount,rw /flash`, and reboot. `storage.tar` holds Kodi's state,
with the databases in `.dbbackup/`.

The CoreELEC settings pages for Network and Bluetooth fail to load: PyGObject
calls `pkgutil.get_loader`, which Python 3.14 removed.
