"""Mark the info dialog's movie, episode or TV show watched."""

import datetime
import json
import sys

import xbmc
import xbmcgui


def rpc(method, **params):
    reply = json.loads(
        xbmc.executeJSONRPC(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": method,
                    "params": params,
                }
            )
        )
    )
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


def mark_item(kind, dbid):
    name = kind.capitalize()
    key = kind + "id"
    details = rpc(
        f"VideoLibrary.Get{name}Details",
        **{
            key: dbid,
            "properties": ["playcount", "resume"],
        },
    )[kind + "details"]
    count = details.get("playcount", 0)
    params = {
        key: dbid,
        "playcount": max(1, count),
        "resume": {"position": 0, "total": 0},
    }
    if not count:
        params["lastplayed"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rpc(f"VideoLibrary.Set{name}Details", **params)
    saved = rpc(
        f"VideoLibrary.Get{name}Details",
        **{
            key: dbid,
            "properties": ["playcount", "resume"],
        },
    )[kind + "details"]
    if saved.get("playcount", 0) < 1 or saved.get("resume", {}).get("position", 0):
        raise RuntimeError(f"Kodi did not save watched state for {kind} {dbid}")


def refresh_info(kind, dbid):
    if xbmcgui.getCurrentWindowDialogId() != 12003:
        return
    if xbmc.getInfoLabel("ListItem.DBType") != kind or xbmc.getInfoLabel(
        "ListItem.DBID"
    ) != str(dbid):
        return
    details = rpc(
        f"VideoLibrary.Get{kind.capitalize()}Details",
        **{
            kind + "id": dbid,
            "properties": ["file", "title"],
        },
    )[kind + "details"]
    item = xbmcgui.ListItem(label=details["label"], path=details["file"])
    tag = item.getVideoInfoTag()
    tag.setDbId(dbid)
    tag.setMediaType(kind)
    tag.setTitle(details["title"])
    # The active native dialog accepts a fresh item without closing or changing focus.
    xbmcgui.Dialog().info(item)


def main():
    kind, value = sys.argv[1:]
    if kind not in ("movie", "episode", "tvshow") or not value.isdecimal():
        raise ValueError("A library movie, episode or TV show is required")
    dbid = int(value)
    if dbid < 1:
        raise ValueError("A positive library ID is required")
    if kind == "tvshow":
        episodes = rpc("VideoLibrary.GetEpisodes", tvshowid=dbid).get("episodes", [])
        if not episodes:
            raise ValueError("This TV show has no library episodes")
        if not xbmcgui.Dialog().yesno(
            "Mark as watched", "Mark every library episode of this TV show as watched?"
        ):
            return
        for episode in episodes:
            mark_item("episode", episode["episodeid"])
    else:
        mark_item(kind, dbid)
    refresh_info(kind, dbid)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        xbmc.log(f"kodi-customize: mark watched failed: {error}", xbmc.LOGERROR)
        xbmcgui.Dialog().ok("Mark as watched failed", str(error))
