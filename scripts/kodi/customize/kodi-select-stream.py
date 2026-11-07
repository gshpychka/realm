"""OSD action: select the playing video's audio or video stream (argument
"audio" or "video")."""

import json
import sys

import xbmc
import xbmcgui

# Per kind: the JSON-RPC stream list, its current stream and its setter.
KINDS = {
    "audio": ("audiostreams", "currentaudiostream", "Player.SetAudioStream"),
    "video": ("videostreams", "currentvideostream", "Player.SetVideoStream"),
}


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
    """The stream's list entry, e.g. "English - Main (truehd, 8 ch) (1/2)"."""
    language = xbmc.convertLanguage(stream["language"], xbmc.ENGLISH_NAME)
    name = " - ".join(part for part in (language, stream["name"]) if part)
    details = [stream["codec"]] if stream["codec"] else []
    if "channels" in stream:
        details.append(f"{stream['channels']} ch")
    if "width" in stream:
        details.append(f"{stream['width']}x{stream['height']}")
    return f"{name} ({', '.join(details)}) ({stream['index'] + 1}/{count})".lstrip()


def main():
    kind = sys.argv[1]
    streams_property, current_property, setter = KINDS[kind]
    # The video player is always player 1.
    properties = rpc(
        "Player.GetProperties",
        playerid=1,
        properties=[streams_property, current_property],
    )
    streams = properties[streams_property]
    current = (properties.get(current_property) or {}).get("index", 0)
    selected = xbmcgui.Dialog().select(
        f"{kind.capitalize()} stream",
        [label(stream, len(streams)) for stream in streams],
        preselect=current,
    )
    if selected >= 0 and streams[selected]["index"] != current:
        rpc(setter, playerid=1, stream=streams[selected]["index"])


if __name__ == "__main__":
    main()
