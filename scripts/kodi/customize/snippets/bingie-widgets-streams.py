# kodi-customize: InfoTagger takes a list of stream dicts per stream type
# A stream type the file lacks, e.g. subtitles, holds Kodi's empty stream list.
stream_details = {
    k: [s for s in v if isinstance(s, dict)] for k, v in stream_details.items()
}
# kodi-customize: end
