"""OSD action: select HDR10+ mapping and reopen the video at its position.

CPM reads these settings when opening the decoder. Hybrid files offer native
HDR10+, original Dolby Vision, and Dolby Vision built from HDR10+ metadata.
Kodi saves the settings, and kodi-customize.sh deliberately leaves them alone.
"""

import json

import xbmc
import xbmcgui

PREFIX = "coreelec.amlogic.dolbyvision."
CONVERT = PREFIX + "hdr10plus.convert"
PRIORITY = PREFIX + "dual.priority"
PREFER = PREFIX + "hdr10plus.prefer.convert"
BUSY = "KodiCustomize.Hdr10PlusBusy"


def rpc(method, **params):
    reply = json.loads(
        xbmc.executeJSONRPC(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        )
    )
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


def set_setting(setting, value):
    if rpc("Settings.SetSettingValue", setting=setting, value=value) is not True:
        raise RuntimeError(f"Kodi rejected {setting}")


class MappingPlayer(xbmc.Player):
    ready = False
    stopped = False

    def onAVStarted(self):
        self.ready = True

    def onPlayBackStopped(self):
        self.stopped = True


def select_mapping():
    player = MappingPlayer()
    if not player.isPlayingVideo() or xbmc.getCondVisibility(
        "VideoPlayer.Content(livetv)"
    ):
        return

    # Settings.GetSettingValue rejects hidden settings too: native priority
    # hides conversion, and disabled conversion hides its preference. Kodi's
    # boolean info interface reads their actual values regardless of visibility.
    convert = xbmc.getCondVisibility(f"System.GetBool({CONVERT})")
    priority = rpc("Settings.GetSettingValue", setting=PRIORITY)["value"]
    prefer = xbmc.getCondVisibility(f"System.GetBool({PREFER})")
    source_types = {
        xbmc.getInfoLabel("Player.Process(video.source.hdr.type)"),
        xbmc.getInfoLabel("Player.Process(video.source.additional.hdr.type)"),
    }
    if "HDR10+" not in source_types:
        return
    modes = ["Native HDR10+", "HDR10+ mapped to DoVi"]
    if "Dolby Vision" in source_types:
        modes.insert(1, "Original DoVi")
    current = (
        "Native HDR10+"
        if not convert or priority == 1
        else "Original DoVi"
        if not prefer and "Dolby Vision" in source_types
        else "HDR10+ mapped to DoVi"
    )
    path = player.getPlayingFile()
    selected = xbmcgui.Dialog().select(
        "HDR10+ mapping", modes, preselect=modes.index(current)
    )
    if selected < 0 or modes[selected] == current:
        return
    target = modes[selected]

    # Read position after the picker closes; the movie can keep playing in it.
    if not player.isPlayingVideo() or player.getPlayingFile() != path:
        return
    item = player.getPlayingItem()
    position = player.getTime()
    paused = xbmc.getCondVisibility("Player.Paused")
    properties = rpc(
        "Player.GetProperties",
        playerid=1,
        properties=["currentaudiostream", "currentsubtitle", "subtitleenabled"],
    )
    try:
        # Conversion is hidden (and JSON-RPC rejects it) at HDR10+ priority.
        # Its preference is hidden while conversion is off.
        set_setting(PRIORITY, 0)
        set_setting(CONVERT, True)
        set_setting(PREFER, target == "HDR10+ mapped to DoVi")
        if target == "Native HDR10+":
            set_setting(CONVERT, False)
            set_setting(PRIORITY, 1)
    except RuntimeError:
        set_setting(PRIORITY, 0)
        set_setting(CONVERT, True)
        set_setting(PREFER, prefer)
        set_setting(CONVERT, convert)
        set_setting(PRIORITY, priority)
        raise

    item.setProperty("StartOffset", str(position))
    monitor = xbmc.Monitor()
    # A direct play() while the old decoder is open reuses CPM's VideoPlayer
    # state. Finish its HDR/HDMI teardown before opening the new mapping.
    player.stop()
    for _ in range(150):
        if player.stopped and not player.isPlaying():
            break
        if monitor.waitForAbort(0.1):
            return
    else:
        raise RuntimeError("Video did not stop; mapping applies on next playback")
    player.ready = False
    player.play(path, item)
    for _ in range(150):
        if player.ready:
            break
        if monitor.waitForAbort(0.1):
            return
    else:
        raise RuntimeError("Video did not reopen; mapping applies on next playback")

    # Reopening the decoder resets track selection and pause state.
    for prop, method, argument in (
        ("currentaudiostream", "Player.SetAudioStream", "stream"),
        ("currentsubtitle", "Player.SetSubtitle", "subtitle"),
    ):
        stream = properties.get(prop) or {}
        if "index" in stream:
            rpc(method, playerid=1, **{argument: stream["index"]})
    rpc(
        "Player.SetSubtitle",
        playerid=1,
        subtitle="on" if properties["subtitleenabled"] else "off",
    )
    if paused:
        rpc("Player.PlayPause", playerid=1, play=False)
    xbmcgui.Dialog().notification("HDR10+", target, time=2500)


def main():
    home = xbmcgui.Window(10000)
    if home.getProperty(BUSY):
        return
    home.setProperty(BUSY, "true")
    try:
        select_mapping()
    except (RuntimeError, KeyError, TypeError, ValueError) as error:
        xbmc.log(f"HDR10+ OSD: {error}", xbmc.LOGERROR)
        xbmcgui.Dialog().notification("HDR10+", str(error), xbmcgui.NOTIFICATION_ERROR)
    finally:
        home.clearProperty(BUSY)


if __name__ == "__main__":
    main()
