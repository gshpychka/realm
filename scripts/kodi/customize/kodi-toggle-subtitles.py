"""OSD action: show or hide the selected subtitles without a notification."""

import xbmc

xbmc.Player().showSubtitles(not xbmc.getCondVisibility("VideoPlayer.SubtitlesEnabled"))
