# kodi-customize: Dolby Vision profile and HDR10+ from Plex in the HDR type
# Kodi stores the HDR type as free text, so this extends PKC's value to e.g.
# dolbyvision-p8.1, dolbyvision-p7-hdr10plus or hdr10plus. The skin patches in
# kodi-customize.sh read these back.
dovi_profile = stream.get("DOVIProfile")
if track["hdr"] == "dolbyvision" and dovi_profile:
    track["hdr"] += "-p" + dovi_profile
    # Profiles 8 and 10 are named by their base layer compatibility, e.g. 8.1.
    if dovi_profile in ("8", "10") and stream.get("DOVIBLCompatID"):
        track["hdr"] += "." + stream.get("DOVIBLCompatID")
if stream.get("HDR10PlusPresent") == "1":
    if track["hdr"] and track["hdr"].startswith("dolbyvision"):
        track["hdr"] += "-hdr10plus"
    else:
        track["hdr"] = "hdr10plus"
# kodi-customize: end
