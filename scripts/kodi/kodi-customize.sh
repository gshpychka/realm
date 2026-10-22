#!/bin/sh
# Customizations to Kodi settings, the Bingie skin and PlexKodiConnect on the
# kodi box. Kodi overwrites an addon's directory on every update, so this is
# idempotent and reruns at boot and after each update
# (kodi-customize.{service,path}). Deployment: scripts/kodi/runbook.md.
set -eu

HERE=$(dirname "$(readlink -f "$0")")
ADDONS=/storage/.kodi/addons
SKIN=$ADDONS/skin.bingie/1080i
PKC_MEDIA=$ADDONS/plugin.video.plexkodiconnect/resources/lib/plex_api/media.py
WIDGETS_KODIDB=$ADDONS/script.bingie.widgets/resources/lib/helpers/kodidb.py
GUISETTINGS=/storage/.kodi/userdata/guisettings.xml
DATABASE=/storage/.kodi/userdata/Database

# Kodi keeps the subtitle position per display mode; every mode whose GUI is
# 1080 lines tall gets the same one, low enough for two lines of subtitles to
# fit in a 2.39:1 bar.
SUBTITLES_POSITION_1080=1080

# Kodi's settings, one "id value" pair per line with the value as a JSON
# literal of the setting's type, a number setting's with a decimal point;
# string values hold no JSON escapes or XML special characters. Kodi accepts a
# setting only while the settings it depends on show it, so each one follows
# those.
kodi_settings() {
  cat <<'EOF'
# Player-led Dolby Vision on demand: the box runs the Dolby Vision processing
# and sends HDR10, which is how the S95C, a TV without Dolby Vision, shows it.
coreelec.amlogic.dolbyvision.mode 1
coreelec.amlogic.dolbyvision.type 2
# VS10 bypassed (5) for every source except Dolby Vision (0).
coreelec.amlogic.dolbyvision.vs10.sdr8 5
coreelec.amlogic.dolbyvision.vs10.sdr10 5
coreelec.amlogic.dolbyvision.vs10.hdr10 5
coreelec.amlogic.dolbyvision.vs10.hdr10plus 5
coreelec.amlogic.dolbyvision.vs10.hdrhlg 5
coreelec.amlogic.dolbyvision.vs10.dv 0
# "Min PQ 20 and limit max" with brightness adjustment -1 clips least near
# black on the S95C: the black-clipping patterns in hoard's test-files show
# from code 68 in Dolby Vision and 66 in HDR10.
coreelec.amlogic.dolbyvision.ll.vsvdb.limit 2
coreelec.amlogic.dolbyvision.ll.vsvdb.limit.brightness -1
# The injected VSVDB describes the S95C: BT.2020, 0 to 1252 cd/m². RTINGS
# measures its peak at about 1,200–1,230 cd/m².
coreelec.amlogic.dolbyvision.vsvdb.inject true
coreelec.amlogic.dolbyvision.vsvdb.colour.space 1
coreelec.amlogic.dolbyvision.vsvdb.min.luminance 0
coreelec.amlogic.dolbyvision.vsvdb.max.luminance 17
coreelec.amlogic.dolbyvision.vsvdb.payload "4903885698A953"
# The injected HDR InfoFrame declares BT.2020, mastering 1200 cd/m², MaxCLL
# 1230 and MaxFALL 234.
coreelec.amlogic.dolbyvision.hdr.inject true
coreelec.amlogic.dolbyvision.hdr.payload "3421AA9B9619FC08488A0839133D4240B0040100CE04EA00"
# HDR10+ conversion, dual-format priority and conversion preference belong to
# the OSD button (kodi-hdr10plus.py), so boot/update runs preserve the choice.
# Subtitles sit at a fixed spot (manual alignment, 0) near the bottom of the
# screen. Almost every film in the library has its letterbox bars baked into a
# 16:9 frame, so Kodi's "bottom of video, outside" places them over the
# picture. The vertical margin is a percentage of the screen height.
subtitles.align 0
subtitles.marginvertical 2.0
EOF
}

log() {
  logger -t kodi-customize "$1"
  echo "$1"
}

status=0
reload_skin=0

# Inserts SNIPPET before the single line of FILE containing ANCHOR, indented
# like that line. A snippet starts with a unique marker line and ends with a
# line containing "kodi-customize: end". If FILE already has the block, this
# does nothing when it matches SNIPPET and replaces it otherwise. Returns 0
# only when it changed FILE.
insert_before() {
  file=$1 anchor=$2 snippet=$3
  marker=$(head -n 1 "$snippet")
  if grep -qF "$marker" "$file"; then
    current=$(awk -v marker="$marker" '
      index($0, marker) { inblock = 1 }
      inblock { sub(/^[ \t]*/, ""); print }
      inblock && /kodi-customize: end/ { exit }
    ' "$file")
    [ "$current" = "$(sed 's/^[ \t]*//' "$snippet")" ] && return 1
    if ! awk -v marker="$marker" '
      index($0, marker) { inblock = 1 }
      inblock { if (/kodi-customize: end/) inblock = 0; next }
      { print }
      END { exit inblock ? 2 : 0 }
    ' "$file" >"$file.tmp.$$"; then
      rm -f "$file.tmp.$$"
      log "block in $file has no end marker, left untouched; restore the addon's file"
      status=1
      return 1
    fi
    mv "$file.tmp.$$" "$file"
  fi
  if [ "$(grep -cF "$anchor" "$file")" != 1 ]; then
    log "anchor not unique or missing in $file, addon changed; update this script: $anchor"
    status=1
    return 1
  fi
  awk -v anchor="$anchor" -v snippet="$snippet" '
    index($0, anchor) {
      match($0, /^[ \t]*/)
      indent = substr($0, 1, RLENGTH)
      while ((getline line < snippet) > 0) print (line == "" ? "" : indent line)
    }
    { print }
  ' "$file" >"$file.tmp.$$"
  mv "$file.tmp.$$" "$file"
}

# insert_before for a Python FILE, which stays unchanged when the result does
# not compile.
insert_before_python() {
  py=$1
  cp "$py" "$py.orig.$$"
  if insert_before "$@"; then
    if python3 -m py_compile "$py" 2>/dev/null; then
      rm -f "$py.orig.$$"
      return 0
    fi
    mv "$py.orig.$$" "$py"
    log "patch to $py does not compile, reverted; update this script"
    status=1
  fi
  rm -f "$py.orig.$$"
  return 1
}

# Hide the profile switcher at the top of the side menu; Bingie has no setting
# for it. It is the group right after the "Logo / user profile button" comment
# in BingieSideBladeMainMenu. Setting its <visible> to false also makes its
# button (id 40000) unfocusable, so the menu's <onup>40000</onup> goes nowhere.
hide_profile() {
  file="$SKIN/IncludesBingie.xml"
  marker='<!-- kodi-bingie-hide-profile -->'
  grep -qF "$marker" "$file" && return 0
  # Replace the first <visible> within 3 lines after the anchor. Exit status 2
  # means the anchor or the <visible> line moved in a new Bingie release.
  if ! awk -v anchor='<!-- Logo / user profile button -->' -v marker="$marker" '
    index($0, anchor) { armed = 4 }
    armed && !done && /<visible>.*<\/visible>/ {
      sub(/<visible>.*<\/visible>/, "<visible>false</visible>" marker)
      done = 1
    }
    armed { armed-- }
    { print }
    END { exit done ? 0 : 2 }
  ' "$file" >"$file.tmp.$$"; then
    rm -f "$file.tmp.$$"
    log "profile switcher anchor not found, skin layout changed; update this script"
    status=1
    return 0
  fi
  mv "$file.tmp.$$" "$file"
  log "profile switcher hidden"
  reload_skin=1
}

# PKC records only whether Dolby Vision is present. Plex also reports the DV
# profile and HDR10+; snippets/pkc-hdr.py adds them to the HDR type that PKC
# writes into Kodi's library. A running PKC keeps the old code until Kodi
# restarts, and existing items only change on a PKC "repair" sync.
pkc_hdr() {
  [ -f "$PKC_MEDIA" ] || return 0
  if insert_before_python "$PKC_MEDIA" "videotracks.append(track)" "$HERE/snippets/pkc-hdr.py"; then
    log "PKC HDR details patched; restart Kodi to load it"
  fi
}

# Bingie's widgets hand InfoTagger an empty list in place of each stream type
# an item's file lacks, which InfoTagger 0.0.9 rejects.
bingie_widgets_streams() {
  [ -f "$WIDGETS_KODIDB" ] || return 0
  if insert_before_python "$WIDGETS_KODIDB" "info_tag.set_stream_details(stream_details)" \
    "$HERE/snippets/bingie-widgets-streams.py"; then
    log "Bingie widgets stream details patched"
  fi
}

# Bingie compares the HDR type to exactly hdr10, dolbyvision and hlg. Prefix
# matches accept the values from pkc_hdr too, and the HDR row and flag read the
# variables in snippets/bingie-hdr-variables.xml. VideoPlayer.HdrType comes from
# the playing stream, which never has these values, so it stays as is.
bingie_hdr() {
  if insert_before "$SKIN/IncludesVariables.xml" '<variable name="VideoHDRVar">' \
    "$HERE/snippets/bingie-hdr-variables.xml"; then
    log "Bingie HDR variables added"
    reload_skin=1
  fi
  for file in "$SKIN/IncludesBingie.xml" "$SKIN/IncludesMediaFlags.xml"; do
    grep -qE 'String\.IsEqual\(List[iI]tem\.HdrType,(dolbyvision|hdr10)\)|\$INFO\[List[iI]tem\.HdrType,/video/,\.png\]|\$VAR\[VideoHDRVar\]' "$file" || continue
    sed -i \
      -e 's/String\.IsEqual(List[iI]tem\.HdrType,dolbyvision)/String.StartsWith(ListItem.HdrType,dolbyvision)/g' \
      -e 's/String\.IsEqual(List[iI]tem\.HdrType,hdr10)/String.StartsWith(ListItem.HdrType,hdr10)/g' \
      -e 's#\$INFO\[List[iI]tem\.HdrType,/video/,\.png\]#/video/$VAR[KodiCustomizeHdrFlag].png#g' \
      -e 's/\$VAR\[VideoHDRVar\]/$VAR[KodiCustomizeHdrLabel]/g' \
      "$file"
    log "Bingie HDR conditions patched in $(basename "$file")"
    reload_skin=1
  done
  # The HDR badge sizes to its label but caps the text at 160px, which cuts
  # off "DV P8.1 · HDR10+".
  file="$SKIN/IncludesBingie.xml"
  range='/<include name="HDR_Details_Row">/,/<\/control>/'
  if sed -n "$range p" "$file" | grep -q '<textwidth>160</textwidth>'; then
    sed -i "$range s#<textwidth>160</textwidth>#<textwidth>320</textwidth>#" "$file"
    log "Bingie HDR badge widened"
    reload_skin=1
  fi
}

# Remove an obsolete marked snippet without touching the surrounding skin.
remove_block() {
  file=$1 marker=$2
  grep -qF "$marker" "$file" || return 0
  if ! awk -v marker="$marker" '
    index($0, marker) { inblock = 1 }
    inblock { if (/kodi-customize: end/) inblock = 0; next }
    { print }
    END { exit inblock ? 2 : 0 }
  ' "$file" >"$file.tmp.$$"; then
    rm -f "$file.tmp.$$"
    log "block in $file has no end marker, left untouched; restore the addon's file"
    status=1
    return 0
  fi
  mv "$file.tmp.$$" "$file"
  log "removed obsolete HDR10+ OSD block from $file"
  reload_skin=1
}

# DialogSettings.xml is shared by video, audio and other settings dialogs.
# Put our row outside Kodi's generated list (id 5), which Kodi clears and
# rebuilds, and show it only in Video settings. Up/down at the list's ends
# reaches the row; other dialogs retain their navigation.
bingie_hdr10plus_osd() {
  for marker in \
    '<!-- kodi-customize: HDR10+ OSD button -->' \
    '<!-- kodi-customize: HDR10+ classic OSD -->' \
    '<!-- kodi-customize: HDR10+ Bingie OSD -->'; do
    remove_block "$SKIN/IncludesOSD.xml" "$marker"
  done
  for spec in \
    'IncludesVariables.xml|<variable name="VideoHDRVar">|bingie-hdr10plus-variables.xml' \
    'DialogSettings.xml|<!-- templates -->|bingie-hdr10plus-settings.xml'; do
    file=${spec%%|*}
    rest=${spec#*|}
    anchor=${rest%%|*}
    snippet=${rest#*|}
    if insert_before "$SKIN/$file" "$anchor" "$HERE/snippets/$snippet"; then
      log "HDR10+ OSD patched in $file ($snippet)"
      reload_skin=1
    fi
  done
  file="$SKIN/DialogSettings.xml"
  range='/<control type="grouplist" id="5">/,/<\/control>/'
  if sed -n "$range p" "$file" | grep -qE '<on(up|down)>5</on(up|down)>'; then
    sed -i \
      -e "$range s#<onup>5</onup>#<onup condition=\"Window.IsActive(osdvideosettings)\">1090</onup><onup condition=\"!Window.IsActive(osdvideosettings)\">5</onup>#" \
      -e "$range s#<ondown>5</ondown>#<ondown condition=\"Window.IsActive(osdvideosettings)\">1090</ondown><ondown condition=\"!Window.IsActive(osdvideosettings)\">5</ondown>#" \
      "$file"
    log "HDR10+ Video settings navigation patched"
    reload_skin=1
  fi
}

# Bingie's progress-under-title mode (skin setting MovieDetailsHome) swaps an
# in-progress item's details, plot and extra info for a progress row, and
# slides the header down 130px into the gap. These edits keep the details for
# every item, drop the slide, hide the Continue Watching episode label that
# duplicates the regular one, and seat the progress row under the details row.
bingie_progress() {
  for file in "$SKIN/IncludesBingie.xml" "$SKIN/IncludesHomeBingie.xml"; do
    grep -qE '!Integer\.IsGreater\(ListItem\.PercentPlayed,1\)|end="0,130".*PercentPlayed' "$file" || continue
    sed -i \
      -e '/end="0,130".*PercentPlayed/d' \
      -e 's/!Integer\.IsGreater(ListItem\.PercentPlayed,1)/true/g' \
      -e 's#<visible>!\[Integer\.IsGreater(ListItem\.PercentPlayed,1) | .*\]\]</visible>#<visible>true</visible>#' \
      -e '/Seasons and Episodes for Continue Watching -->/,/<\/control>/s#<visible>Skin\.HasSetting(MovieDetailsHome)</visible>#<visible>false</visible>#' \
      -e '/Movie and TV Show Continue Watching -->/,/<\/control>/s#<top>39</top>#<top>20</top>#' \
      "$file"
    log "Bingie progress row placed under the details in $(basename "$file")"
    reload_skin=1
  done
}

# Kodi rewrites guisettings.xml from memory when it exits, so the file is only
# written while Kodi is stopped, i.e. at boot before kodi.service.
settings_file() {
  missing=$GUISETTINGS.missing.$$
  KODI_SETTINGS=$(kodi_settings) awk -v pos="$SUBTITLES_POSITION_1080" -v missing="$missing" '
    BEGIN {
      n = split(ENVIRON["KODI_SETTINGS"], lines, "\n")
      for (i = 1; i <= n; i++) {
        if (lines[i] ~ /^[ \t]*(#|$)/) continue
        id = value = lines[i]
        sub(/[ \t].*/, "", id)
        sub(/^[^ \t]+[ \t]+/, "", value)
        gsub(/^"|"$/, "", value)
        want[id] = value
      }
    }
    match($0, /<setting id="[^"]*"/) {
      id = substr($0, RSTART + 13, RLENGTH - 14)
      if (id in want) {
        found[id] = 1
        current = $0
        if (current ~ /\/>[ \t]*$/) {
          current = ""
        } else {
          sub(/^[^>]*>/, "", current)
          sub(/<\/setting>.*/, "", current)
        }
        number = "^-?[0-9]+(\\.[0-9]+)?$"
        same = current == want[id] || (current ~ number && want[id] ~ number && current + 0 == want[id] + 0)
        if (!same) {
          match($0, /^[ \t]*/)
          print substr($0, 1, RLENGTH) "<setting id=\"" id "\">" want[id] "</setting>"
          next
        }
      }
    }
    /<resolution>/ { inres = 1; buf = "" }
    inres {
      buf = buf $0 "\n"
      if (/<\/resolution>/) {
        if (buf ~ /<bottom>1080<\/bottom>/)
          gsub(/<subtitles>[0-9]+<\/subtitles>/, "<subtitles>" pos "</subtitles>", buf)
        printf "%s", buf
        inres = 0
      }
      next
    }
    { print }
    END {
      printf "" >missing
      for (id in want)
        if (!(id in found)) print id >missing
    }
  ' "$GUISETTINGS" >"$GUISETTINGS.tmp.$$"
  for id in $(cat "$missing"); do
    log "setting $id missing from guisettings.xml, Kodi or CoreELEC changed; update this script"
    status=1
  done
  rm -f "$missing"
  if [ "$(md5sum <"$GUISETTINGS.tmp.$$")" = "$(md5sum <"$GUISETTINGS")" ]; then
    rm -f "$GUISETTINGS.tmp.$$"
    return 0
  fi
  mv "$GUISETTINGS.tmp.$$" "$GUISETTINGS"
  log "Kodi settings applied to guisettings.xml"
}

# A running Kodi takes the settings over JSON-RPC and saves them when it exits.
# The per-display-mode subtitle position waits for the next boot.
settings_live() {
  if ! out=$(kodi_settings | python3 "$HERE/kodi-settings-rpc.py" 2>&1); then
    log "Kodi JSON-RPC failed, settings apply at the next boot: $out"
    status=1
    return 0
  fi
  printf '%s\n' "$out" | while read -r kind id value; do
    case $kind in
    changed) log "Kodi setting $id set to $value" ;;
    rejected) log "Kodi rejected setting $id: missing, or hidden by a setting before it; update this script" ;;
    esac
  done
  case $out in *rejected*) status=1 ;; esac
}

# Version of an installed or shipped add-on; its <addon> tag can span lines.
addon_version() {
  [ -f "$1/addon.xml" ] || return 0
  tr '\n' ' ' <"$1/addon.xml" | sed -n 's/.*<addon[ \t][^>]*version="\([^"]*\)".*/\1/p'
}

# Skin Shortcuts 3.x refuses Bingie, so 2.1.0 stays installed with the pin
# Kodi records when an add-on is downgraded (update rule 2, PIN_OLD_VERSION).
# Kodi loads the rules from its add-on database when it scans add-ons, so the
# pin is written at boot, before its first scan.
pin_skinshortcuts() {
  db=$(ls "$DATABASE"/Addons*.db 2>/dev/null | sort -V | tail -n 1)
  if [ -z "$db" ]; then
    log "Kodi add-on database missing, Skin Shortcuts left unpinned"
    status=1
    return 0
  fi
  added=$(sqlite3 "$db" "INSERT OR IGNORE INTO update_rules (addonID, updateRule) VALUES ('script.skinshortcuts', 2); SELECT changes();")
  [ "$added" = 1 ] && log "Skin Shortcuts pinned"
  version=$(addon_version "$ADDONS/script.skinshortcuts")
  case $version in
  2.*) ;;
  *)
    log "Skin Shortcuts ${version:-missing}, Bingie needs 2.1.0; install it from Kodi's add-on info"
    status=1
    ;;
  esac
}

# Add-ons pinned to a release newer than Kodi's repository carries: InfoTagger
# 0.0.9, as the repository's 0.0.8 drops every video stream carrying Kodi 22's
# hdrdetail field. An installed copy older than the shipped one is replaced at
# boot, so Kodi registers the shipped version when it scans add-ons.
install_pinned_addons() {
  for src in "$HERE"/addons/*; do
    [ -f "$src/addon.xml" ] || continue
    id=$(basename "$src")
    shipped=$(addon_version "$src")
    installed=$(addon_version "$ADDONS/$id")
    newest=$(printf '%s\n%s\n' "$shipped" "$installed" | sort -V | tail -n 1)
    [ -n "$installed" ] && [ "$newest" = "$installed" ] && continue
    rm -rf "${ADDONS:?}/$id"
    cp -r "$src" "$ADDONS/$id"
    log "installed $id $shipped over ${installed:-nothing}"
  done
}

# Whole-window overrides, e.g. PlexKodiConnect's skip marker dialog. Kodi
# resolves an addon's window XML in the active skin first, but only sees a new
# file in the skin directory after a skin reload.
install_overrides() {
  for src in "$HERE"/skin-overrides/*.xml; do
    [ -f "$src" ] || continue
    dst="$SKIN/$(basename "$src")"
    if [ -f "$dst" ] && [ "$(md5sum <"$src")" = "$(md5sum <"$dst")" ]; then
      continue
    fi
    cp "$src" "$dst"
    log "installed $(basename "$src")"
    reload_skin=1
  done
}

pkc_hdr
bingie_widgets_streams
if systemctl -q is-active kodi.service; then
  settings_live
else
  if [ -f "$GUISETTINGS" ]; then
    settings_file
  fi
  pin_skinshortcuts
  install_pinned_addons
fi
if [ -d "$SKIN" ]; then
  hide_profile
  bingie_hdr
  bingie_hdr10plus_osd
  bingie_progress
  install_overrides
fi

if [ "$reload_skin" = 1 ] && systemctl -q is-active kodi.service; then
  kodi-send --action="RunScript($HERE/kodi-reload-skin.py)" >/dev/null
fi
exit "$status"
