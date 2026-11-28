# kodi-customize: provider ratings in video metadata
if jsonmethod in (
    "VideoLibrary.GetMovies", "VideoLibrary.GetMovieDetails",
    "VideoLibrary.GetTvShows", "VideoLibrary.GetTvShowDetails",
    "VideoLibrary.GetEpisodes", "VideoLibrary.GetEpisodeDetails",
):
    fields = list(dict.fromkeys([*fields, "ratings"]))
# kodi-customize: end
