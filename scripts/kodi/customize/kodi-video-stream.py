"""OSD action: select the playing video's video stream."""

import json

import xbmc
import xbmcgui


def rpc(method, **params):
    reply = json.loads(
        xbmc.executeJSONRPC(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        )
    )
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


def label(stream, count):
    """The stream's list entry, e.g. "English - Main (hevc, 3840x2160) (1/2)"."""
    language = xbmc.convertLanguage(stream["language"], xbmc.ENGLISH_NAME)
    name = " - ".join(part for part in (language, stream["name"]) if part)
    codec = f"{stream['codec']}, " if stream["codec"] else ""
    size = f"{stream['width']}x{stream['height']}"
    return f"{name} ({codec}{size}) ({stream['index'] + 1}/{count})".lstrip()


def main():
    # The video player is always player 1.
    properties = rpc(
        "Player.GetProperties",
        playerid=1,
        properties=["videostreams", "currentvideostream"],
    )
    streams = properties["videostreams"]
    current = (properties.get("currentvideostream") or {}).get("index", 0)
    selected = xbmcgui.Dialog().select(
        "Video stream",
        [label(stream, len(streams)) for stream in streams],
        preselect=current,
    )
    if selected >= 0 and streams[selected]["index"] != current:
        rpc("Player.SetVideoStream", playerid=1, stream=streams[selected]["index"])


if __name__ == "__main__":
    main()
