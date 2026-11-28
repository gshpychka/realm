# kodi-customize: preserve each rating provider on widget items
for provider, rating in item.get("ratings", {}).items():
    liz.getVideoInfoTag().setRating(
        float(rating["rating"]),
        int(rating.get("votes", 0)),
        provider,
        bool(rating.get("default", False)),
    )
# kodi-customize: end
