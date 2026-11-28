"""Patch Bingie's media details and info-menu controls, preserving source XML."""

from pathlib import Path
import re
import sys


# Bingie's XML contains raw ampersands. Match balanced element ranges without
# parsing and serializing unrelated upstream markup.
def replace_elements(text, tag, attributes, transform, expected=1):
    opening = re.compile(r"<" + tag + r"\b[^>]*>")
    tokens = re.compile(r"</?" + tag + r"\b[^>]*>")
    spans = []
    for match in opening.finditer(text):
        if not all(re.search(r'\b' + key + r'="' + re.escape(value) + r'"', match[0])
                   for key, value in attributes.items()):
            continue
        depth = 1
        for token in tokens.finditer(text, match.end()):
            if token[0].startswith("</"):
                depth -= 1
            elif not token[0].endswith("/>"):
                depth += 1
            if depth == 0:
                spans.append((match.start(), token.end()))
                break
        else:
            raise ValueError(f"unclosed {tag}: {attributes}")
    if len(spans) != expected:
        raise ValueError(f"anchor not found or not unique: {tag} {attributes} ({len(spans)})")
    for start, end in reversed(spans):
        text = text[:start] + transform(text[start:end]) + text[end:]
    return text


def hide(block):
    marker = '<!-- kodi-customize: hide thumbs -->'
    if marker not in block:
        end = block.index(">") + 1
        block = block[:end] + '\n<visible>false</visible>' + marker + block[end:]
    return block


def rating_row(name, label_id, variable):
    return f'''<include name="{name}">
        <!-- kodi-customize: genuine IMDb rating -->
        <control type="group">
            <visible>!String.IsEmpty(Control.GetLabel({label_id}))</visible>
            <width>150</width>
            <height>50</height>
            <control type="image">
                <left>0</left>
                <top>9</top>
                <width>60</width>
                <height>30</height>
                <aspectratio>keep</aspectratio>
                <texture>bingie/ratings/imdb.png</texture>
            </control>
            <control type="label" id="{label_id}">
                <left>68</left>
                <top>7</top>
                <width>82</width>
                <height>36</height>
                <aligny>center</aligny>
                <font>Reg24</font>
                <textcolor>$INFO[Skin.String(BingieDeatailsTextColor)]</textcolor>
                <label>$VAR[{variable}]</label>
            </control>
        </control>
    </include>'''


VARIABLES = '''
    <!-- kodi-customize: IMDb variables -->
    <variable name="KodiCustomizeIMDbRating">
        <value condition="Integer.IsGreater(ListItem.Rating(imdb),0)">$INFO[ListItem.Rating(imdb)]</value>
        <value condition="$EXP[EXP_TMDbBingieHelper_Metadata] + Integer.IsGreater(Container(17195).ListItem.Property(IMDb_Rating),0)">$INFO[Container(17195).ListItem.Property(IMDb_Rating)]</value>
        <value></value>
    </variable>
    <variable name="KodiCustomizeIMDbRatingSeasons">
        <value condition="Integer.IsGreater(Container(5027).ListItem.Rating(imdb),0)">$INFO[Container(5027).ListItem.Rating(imdb)]</value>
        <value></value>
    </variable>
    <!-- kodi-customize: end IMDb variables -->
'''


def details(text):
    for name in ("Thumbs_Up_Details_Row", "Thumbs_Down_Details_Row"):
        text = replace_elements(text, "include", {"name": name},
                                lambda block: replace_elements(block, "control", {"type": "image"}, hide))
    for name, label_id, variable in (
        ("Percentage_Rating_Details_Row", "6113", "KodiCustomizeIMDbRating"),
        ("Percentage_Rating_Details_Row_Seasons", "61132", "KodiCustomizeIMDbRatingSeasons"),
    ):
        text = replace_elements(text, "include", {"name": name},
                                lambda block: rating_row(name, label_id, variable))
    pattern = r'\n    <!-- kodi-customize: IMDb variables -->.*?<!-- kodi-customize: end IMDb variables -->\n'
    if re.search(pattern, text, re.S):
        return re.sub(pattern, lambda match: VARIABLES, text, flags=re.S)
    if text.count("</includes>") != 1:
        raise ValueError("anchor not found: </includes>")
    return text.replace("</includes>", VARIABLES + "</includes>")


def watched_button(template):
    button = template.replace('id="52"', 'id="9700"', 1)
    button = re.sub(r'\s*<visible>.*?</visible>', '', button, flags=re.S)
    condition = '!String.IsEmpty(ListItem.DBID) + [String.IsEqual(ListItem.DBType,movie) | String.IsEqual(ListItem.DBType,episode) | String.IsEqual(ListItem.DBType,tvshow)]'
    button = button.replace('id="9700">', 'id="9700">\n<visible>' + condition + '</visible>', 1)
    button = re.sub(r'<label>.*?</label>', '<label>Mark as watched</label>', button, count=1, flags=re.S)
    button = button.replace('dialogs/videoinfo/info/play_beginning.png', 'overlays/normal/watched.png')
    button = re.sub(r'\s*<!--.*?-->', '', button, flags=re.S)
    button = re.sub(r'\s*<onclick\b[^>]*>.*?</onclick>', '', button, flags=re.S)
    action = 'RunScript(/storage/.config/kodi-customize/kodi-mark-watched.py,$INFO[ListItem.DBType],$INFO[ListItem.DBID])'
    return button.rsplit('</control>', 1)[0] + '<onclick>' + action + '</onclick>\n</control>'


def info_menu(text):
    for group in ("700", "701"):
        text = replace_elements(text, "control", {"type": "grouplist", "id": group}, hide)
    # Both the horizontal and vertical info layouts have their own play buttons.
    text = re.sub(r'\n<!-- kodi-customize: watched button -->\n.*?<!-- kodi-customize: end watched button -->',
                  '', text, flags=re.S)
    text = replace_elements(text, "control", {"type": "radiobutton", "id": "52"},
                            lambda block: block + '\n<!-- kodi-customize: watched button -->\n'
                            + watched_button(block) + '\n<!-- kodi-customize: end watched button -->', expected=2)
    return text


def main():
    skin = Path(sys.argv[1])
    pending = []
    for filename, transform in (("IncludesBingie.xml", details),
                                ("IncludesDialogVideoInfo.xml", info_menu)):
        path = skin / filename
        before = path.read_text()
        after = transform(before)
        if after != before:
            pending.append((path, after))
    for path, content in pending:
        temporary = path.with_suffix(path.suffix + ".kodi-customize")
        temporary.write_text(content)
        temporary.replace(path)
        print(f"patched {path.name}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
