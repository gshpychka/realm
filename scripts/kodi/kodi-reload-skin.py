"""Apply skin edits once playback has stopped, preserving the playing video.

ReloadSkin tears down CPM's playback state, so addon updates and deployments
must wait for an idle player. A window property coalesces repeated requests.
"""

import xbmc
import xbmcgui


def main():
    home = xbmcgui.Window(10000)
    pending = "KodiCustomize.SkinReloadPending"
    if home.getProperty(pending):
        return
    home.setProperty(pending, "true")
    reload_skin = False
    try:
        monitor = xbmc.Monitor()
        player = xbmc.Player()
        while not monitor.abortRequested():
            if player.isPlaying() or home.getProperty("KodiCustomize.Hdr10PlusBusy"):
                if monitor.waitForAbort(1):
                    return
                continue
            # Allow stop cleanup to finish, and ignore brief gaps in playback.
            if monitor.waitForAbort(1):
                return
            if not player.isPlaying() and not home.getProperty(
                "KodiCustomize.Hdr10PlusBusy"
            ):
                reload_skin = True
                break
    finally:
        home.clearProperty(pending)
    # ReloadSkin destroys the old windows. Release Python's window handle
    # before requesting it, so cleanup cannot access a destroyed window.
    del home
    if reload_skin:
        xbmc.executebuiltin("ReloadSkin()")


if __name__ == "__main__":
    main()
