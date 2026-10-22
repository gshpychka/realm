# Radarr and Sonarr settings as set in their UIs, converged by my.arrSync
# (modules/system/nixos/arr-sync.nix) on every start of the app. Values were
# taken from the live apps on 2026-10-16 and are kept as they were, not reset
# to TRaSH defaults.
#
# Owned here: naming, media management (importing, file management,
# permissions), download handling (completed/failed download handling),
# indexer options, import list sync level, UI, Radarr's metadata
# certification country, the default delay profile, every quality size, the
# Radarr "Any" profile's language, the saved custom filters (server-side, in
# /customfilter; which filter a browser has selected is that browser's own
# local state), the metadata consumers (all off) and the host settings in
# ./host.nix. Recyclarr (./recyclarr.nix) owns the custom formats and the rest
# of the "Any" profiles; ./sync.nix the root folders, download clients and
# Prowlarr applications; ./notifications.nix the notifications;
# ./import-lists.nix the import lists.
#
# Not declared, as runtime state or owned elsewhere: import list exclusions
# (added when a movie/series is deleted with "prevent re-adding"), tags other
# than the import lists' (Seerr creates one per user), indexers (pushed by
# Prowlarr), Sonarr's language profile (a v3 leftover v4 doesn't use).
_:
let
  filter = key: type: value: { inherit key type value; };
  # the app seeds one consumer per implementation; all are off here
  consumer = id: name: implementation: fields: {
    inherit
      id
      name
      implementation
      fields
      ;
    enable = false;
  };
in
{
  my.arrSync.targets = {
    radarr = {
      settings = {
        "config/naming" = {
          colonReplacementFormat = "smart";
          movieFolderFormat = "{Movie CleanTitle} ({Release Year})";
          renameMovies = true;
          replaceIllegalCharacters = false;
          standardMovieFormat = "{Movie CleanTitle} {(Release Year)} {tmdb-{TmdbId}} {edition-{Edition Tags}} {[Custom Formats]}{[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[Mediainfo VideoCodec]}{-Release Group}";
        };
        "config/mediamanagement" = {
          autoRenameFolders = false;
          autoUnmonitorPreviouslyDownloadedMovies = true;
          chmodFolder = "775";
          chownGroup = "media";
          copyUsingHardlinks = true;
          createEmptyMovieFolders = true;
          deleteEmptyFolders = false;
          downloadPropersAndRepacks = "doNotPrefer";
          enableMediaInfo = true;
          extraFileExtensions = "srt";
          fileDate = "none";
          importExtraFiles = false;
          minimumFreeSpaceWhenImporting = 10000;
          pathsDefaultStatic = false;
          recycleBin = "";
          recycleBinCleanupDays = 7;
          rescanAfterRefresh = "always";
          scriptImportPath = "";
          setPermissionsLinux = false;
          skipFreeSpaceCheckWhenImporting = true;
          useScriptImport = false;
        };
        "config/downloadclient" = {
          autoRedownloadFailed = true;
          autoRedownloadFailedFromInteractiveSearch = true;
          checkForFinishedDownloadInterval = 1;
          downloadClientWorkingFolders = "_UNPACK_|_FAILED_";
          enableCompletedDownloadHandling = true;
        };
        "config/indexer" = {
          allowHardcodedSubs = false;
          availabilityDelay = 0;
          maximumSize = 0;
          minimumAge = 0;
          preferIndexerFlags = false;
          retention = 0;
          rssSyncInterval = 30;
          whitelistedHardcodedSubs = "";
        };
        "config/importlist" = {
          listSyncLevel = "disabled";
        };
        "config/ui" = {
          calendarWeekColumnHeader = "ddd M/D";
          enableColorImpairedMode = false;
          firstDayOfWeek = 1;
          longDateFormat = "dddd, MMMM D YYYY";
          movieInfoLanguage = 1;
          movieRuntimeFormat = "hoursMinutes";
          shortDateFormat = "MMM D YYYY";
          showRelativeDates = true;
          theme = "auto";
          timeFormat = "h(:mm)a";
          uiLanguage = 1;
        };
        "config/metadata" = {
          certificationCountry = "us";
        };
        "delayprofile/1" = {
          bypassIfAboveCustomFormatScore = false;
          bypassIfHighestQuality = true;
          enableTorrent = true;
          enableUsenet = true;
          minimumCustomFormatScore = 0;
          order = 2147483647;
          preferredProtocol = "usenet";
          tags = [ ];
          torrentDelay = 0;
          usenetDelay = 0;
        };
      };
      # MB per minute; null is no limit
      qualityDefinitions = {
        Unknown = {
          title = "Unknown";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        WORKPRINT = {
          title = "WORKPRINT";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        CAM = {
          title = "CAM";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        TELESYNC = {
          title = "TELESYNC";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        TELECINE = {
          title = "TELECINE";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        REGIONAL = {
          title = "REGIONAL";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        DVDSCR = {
          title = "DVDSCR";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        SDTV = {
          title = "SDTV";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        DVD = {
          title = "DVD";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        DVD-R = {
          title = "DVD-R";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        WEBDL-480p = {
          title = "WEBDL-480p";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        WEBRip-480p = {
          title = "WEBRip-480p";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        Bluray-480p = {
          title = "Bluray-480p";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        Bluray-576p = {
          title = "Bluray-576p";
          minSize = 0;
          preferredSize = 95;
          maxSize = 100;
        };
        HDTV-720p = {
          title = "HDTV-720p";
          minSize = 17.1;
          preferredSize = 1999;
          maxSize = null;
        };
        WEBDL-720p = {
          title = "WEBDL-720p";
          minSize = 12.5;
          preferredSize = 1999;
          maxSize = null;
        };
        WEBRip-720p = {
          title = "WEBRip-720p";
          minSize = 12.5;
          preferredSize = 1999;
          maxSize = null;
        };
        Bluray-720p = {
          title = "Bluray-720p";
          minSize = 25.7;
          preferredSize = 1999;
          maxSize = null;
        };
        HDTV-1080p = {
          title = "HDTV-1080p";
          minSize = 33.8;
          preferredSize = 1999;
          maxSize = null;
        };
        WEBDL-1080p = {
          title = "WEBDL-1080p";
          minSize = 12.5;
          preferredSize = 1999;
          maxSize = null;
        };
        WEBRip-1080p = {
          title = "WEBRip-1080p";
          minSize = 12.5;
          preferredSize = 1999;
          maxSize = null;
        };
        Bluray-1080p = {
          title = "Bluray-1080p";
          minSize = 50.8;
          preferredSize = null;
          maxSize = null;
        };
        Remux-1080p = {
          title = "Remux-1080p";
          minSize = 102;
          preferredSize = null;
          maxSize = null;
        };
        HDTV-2160p = {
          title = "HDTV-2160p";
          minSize = 85;
          preferredSize = null;
          maxSize = null;
        };
        WEBDL-2160p = {
          title = "WEBDL-2160p";
          minSize = 34.5;
          preferredSize = null;
          maxSize = null;
        };
        WEBRip-2160p = {
          title = "WEBRip-2160p";
          minSize = 34.5;
          preferredSize = null;
          maxSize = null;
        };
        Bluray-2160p = {
          title = "Bluray-2160p";
          minSize = 102;
          preferredSize = null;
          maxSize = null;
        };
        Remux-2160p = {
          title = "Remux-2160p";
          minSize = 187.4;
          preferredSize = null;
          maxSize = null;
        };
        BR-DISK = {
          title = "BR-DISK";
          minSize = 0;
          preferredSize = null;
          maxSize = null;
        };
        Raw-HD = {
          title = "Raw-HD";
          minSize = 0;
          preferredSize = null;
          maxSize = null;
        };
      };
      # Recyclarr owns the profile but not its language
      qualityProfiles.Any.language = {
        id = -2;
        name = "Original";
      };
      customFilters = [
        {
          id = 2;
          type = "movieIndex";
          label = "Available Monitored";
          filters = [
            (filter "monitored" "equal" [ true ])
            (filter "isAvailable" "equal" [ true ])
          ];
        }
        {
          id = 3;
          type = "movieIndex";
          label = "misc";
          filters = [ (filter "path" "contains" [ "/misc/" ]) ];
        }
      ];
      metadata = [
        (consumer 1 "Kodi (XBMC) / Emby" "XbmcMetadata" {
          movieMetadata = true;
          useMovieNfo = false;
          # English
          movieMetadataLanguage = 1;
          movieMetadataURL = false;
          addCollectionName = true;
          movieImages = true;
        })
        (consumer 2 "WDTV" "WdtvMetadata" {
          movieMetadata = true;
          movieImages = true;
        })
        (consumer 3 "Roksbox" "RoksboxMetadata" {
          movieMetadata = true;
          movieImages = true;
        })
        (consumer 4 "Emby (Legacy)" "MediaBrowserMetadata" { movieMetadata = true; })
        (consumer 5 "Kometa" "KometaMetadata" { deprecated = true; })
      ];
    };
    sonarr = {
      settings = {
        "config/naming" = {
          animeEpisodeFormat = "{Series TitleYear} - S{season:00}E{episode:00} - {absolute:000} - {Episode CleanTitle} [{Custom Formats }{Quality Full}]{[MediaInfo VideoDynamicRangeType]}[{MediaInfo VideoBitDepth}bit]{[MediaInfo VideoCodec]}[{Mediainfo AudioCodec} { Mediainfo AudioChannels}]{MediaInfo AudioLanguages}{-Release Group}";
          # Smart Replace
          colonReplacementFormat = 4;
          customColonReplacementFormat = "";
          dailyEpisodeFormat = "{Series TitleYear} - {Air-Date} - {Episode CleanTitle:90} {[Custom Formats]}{[Quality Full]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo VideoCodec]}{-Release Group}";
          # Prefixed Range
          multiEpisodeStyle = 5;
          renameEpisodes = true;
          replaceIllegalCharacters = false;
          seasonFolderFormat = "Season {season:00}";
          seriesFolderFormat = "{Series TitleYear} {tvdb-{TvdbId}}";
          specialsFolderFormat = "Specials";
          standardEpisodeFormat = "{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} [{Custom Formats }{Quality Full}]{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[MediaInfo VideoCodec]}{-Release Group}";
        };
        "config/mediamanagement" = {
          autoUnmonitorPreviouslyDownloadedEpisodes = true;
          chmodFolder = "775";
          chownGroup = "media";
          copyUsingHardlinks = true;
          createEmptySeriesFolders = true;
          deleteEmptyFolders = true;
          downloadPropersAndRepacks = "doNotPrefer";
          enableMediaInfo = true;
          episodeTitleRequired = "always";
          extraFileExtensions = "srt";
          fileDate = "none";
          importExtraFiles = false;
          minimumFreeSpaceWhenImporting = 10000;
          recycleBin = "";
          recycleBinCleanupDays = 7;
          rescanAfterRefresh = "always";
          scriptImportPath = "";
          setPermissionsLinux = false;
          skipFreeSpaceCheckWhenImporting = false;
          useScriptImport = false;
        };
        "config/downloadclient" = {
          autoRedownloadFailed = true;
          autoRedownloadFailedFromInteractiveSearch = true;
          downloadClientWorkingFolders = "_UNPACK_|_FAILED_";
          enableCompletedDownloadHandling = true;
        };
        "config/indexer" = {
          maximumSize = 0;
          minimumAge = 0;
          retention = 0;
          rssSyncInterval = 15;
        };
        "config/importlist" = {
          listSyncLevel = "disabled";
          listSyncTag = 0;
        };
        "config/ui" = {
          calendarWeekColumnHeader = "ddd M/D";
          enableColorImpairedMode = false;
          firstDayOfWeek = 1;
          longDateFormat = "dddd, MMMM D YYYY";
          shortDateFormat = "DD MMM YYYY";
          showRelativeDates = true;
          theme = "auto";
          timeFormat = "h(:mm)a";
          uiLanguage = 1;
        };
        "delayprofile/1" = {
          bypassIfAboveCustomFormatScore = false;
          bypassIfHighestQuality = true;
          enableTorrent = true;
          enableUsenet = true;
          minimumCustomFormatScore = 0;
          order = 2147483647;
          preferredProtocol = "usenet";
          tags = [ ];
          torrentDelay = 0;
          usenetDelay = 0;
        };
      };
      customFilters = [
        {
          id = 1;
          type = "queue";
          label = "Warning";
          filters = [
            (filter "status" "equal" [
              "warning"
              "fallback"
              "delay"
              "failed"
              "completed"
            ])
          ];
        }
        {
          id = 2;
          type = "releases";
          label = "Not rejected";
          filters = [ (filter "rejectionCount" "equal" [ 0 ]) ];
        }
        {
          id = 3;
          type = "releases";
          label = "UHD";
          # Sonarr's fixed quality id 18: WEBDL-2160p
          filters = [ (filter "quality" "equal" [ 18 ]) ];
        }
      ];
      metadata = [
        (consumer 1 "Kodi (XBMC) / Emby" "XbmcMetadata" {
          seriesMetadata = true;
          seriesMetadataEpisodeGuide = false;
          seriesMetadataUrl = false;
          episodeMetadata = true;
          episodeImageThumb = false;
          seriesImages = true;
          seasonImages = true;
          episodeImages = true;
        })
        (consumer 2 "WDTV" "WdtvMetadata" {
          episodeMetadata = true;
          seriesImages = true;
          seasonImages = true;
          episodeImages = true;
        })
        (consumer 3 "Roksbox" "RoksboxMetadata" {
          episodeMetadata = true;
          seriesImages = true;
          seasonImages = true;
          episodeImages = true;
        })
        (consumer 4 "Plex" "PlexMetadata" {
          seriesPlexMatchFile = true;
          episodeMappings = true;
        })
        (consumer 5 "Kometa" "KometaMetadata" { deprecated = true; })
      ];
      # MB per minute; null is no limit
      qualityDefinitions = {
        Unknown = {
          title = "Unknown";
          minSize = 1;
          preferredSize = 995;
          maxSize = null;
        };
        SDTV = {
          title = "SDTV";
          minSize = 2;
          preferredSize = 995;
          maxSize = null;
        };
        WEBRip-480p = {
          title = "WEBRip-480p";
          minSize = 2;
          preferredSize = 995;
          maxSize = null;
        };
        WEBDL-480p = {
          title = "WEBDL-480p";
          minSize = 2;
          preferredSize = 995;
          maxSize = null;
        };
        DVD = {
          title = "DVD";
          minSize = 2;
          preferredSize = 995;
          maxSize = null;
        };
        Bluray-480p = {
          title = "Bluray-480p";
          minSize = 2;
          preferredSize = 995;
          maxSize = null;
        };
        Bluray-576p = {
          title = "Bluray-576p";
          minSize = 2;
          preferredSize = 995;
          maxSize = null;
        };
        HDTV-720p = {
          title = "HDTV-720p";
          minSize = 3;
          preferredSize = 995;
          maxSize = null;
        };
        HDTV-1080p = {
          title = "HDTV-1080p";
          minSize = 4;
          preferredSize = 995;
          maxSize = null;
        };
        Raw-HD = {
          title = "Raw-HD";
          minSize = 4;
          preferredSize = 995;
          maxSize = null;
        };
        WEBRip-720p = {
          title = "WEBRip-720p";
          minSize = 10;
          preferredSize = 995;
          maxSize = null;
        };
        WEBDL-720p = {
          title = "WEBDL-720p";
          minSize = 10;
          preferredSize = 995;
          maxSize = null;
        };
        Bluray-720p = {
          title = "Bluray-720p";
          minSize = 17.1;
          preferredSize = 995;
          maxSize = null;
        };
        WEBRip-1080p = {
          title = "WEBRip-1080p";
          minSize = 13;
          preferredSize = 995;
          maxSize = null;
        };
        WEBDL-1080p = {
          title = "WEBDL-1080p";
          minSize = 13;
          preferredSize = 995;
          maxSize = null;
        };
        Bluray-1080p = {
          title = "Bluray-1080p";
          minSize = 50.4;
          preferredSize = 995;
          maxSize = null;
        };
        "Bluray-1080p Remux" = {
          title = "Bluray-1080p Remux";
          minSize = 69.1;
          preferredSize = 995;
          maxSize = null;
        };
        HDTV-2160p = {
          title = "HDTV-2160p";
          minSize = 25;
          preferredSize = 995;
          maxSize = null;
        };
        WEBRip-2160p = {
          title = "WEBRip-2160p";
          minSize = 25;
          preferredSize = 995;
          maxSize = null;
        };
        WEBDL-2160p = {
          title = "WEBDL-2160p";
          minSize = 25;
          preferredSize = 995;
          maxSize = null;
        };
        Bluray-2160p = {
          title = "Bluray-2160p";
          minSize = 94.6;
          preferredSize = 995;
          maxSize = null;
        };
        "Bluray-2160p Remux" = {
          title = "Bluray-2160p Remux";
          minSize = 187.4;
          preferredSize = 995;
          maxSize = null;
        };
      };
    };
  };
}
