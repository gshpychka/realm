"""Brand Gatus's embedded assets without a frontend fork or runtime injection.

Run during postPatch, before Go embeds web/static. Fail on missing anchors so
an upstream UI change cannot silently restore branding or unthemed charts.
"""

import base64
import json
import sys
from pathlib import Path

from PIL import Image


def brand_badges(source: Path) -> None:
    # Detail-page metrics are server-rendered SVG images, not CSS elements.
    # Preserve their values and thresholds while matching the rest of the UI.
    path = source / "api" / "badge.go"
    go = path.read_text()
    replacements = {
        '"#40cc11"': '"#b8bb26"',
        '"#94cc11"': '"#8ec07c"',
        '"#ccd311"': '"#fabd2f"',
        '"#ccb311"': '"#d79921"',
        '"#cc8111"': '"#fe8019"',
        '"#c7130a"': '"#fb4934"',
        '<path fill="#555"': '<path fill="#504945"',
        '<g fill="#fff" text-anchor=': '<g fill="#ebdbb2" text-anchor=',
        '<text x="%d" y="14">\n      %s': '<text x="%d" y="14" fill="#1d2021">\n      %s',
        'stop-opacity=".1"': 'stop-opacity="0"',
        'fill-opacity=".3"': 'fill-opacity="0"',
    }
    for old, new in replacements.items():
        assert old in go, f"upstream SVG badge anchor changed: {old}"
        go = go.replace(old, new)
    path.write_text(go)


def brand(static: Path, image: Path, revision: str) -> None:
    brand_badges(static.parent.parent)
    icon = Image.open(image).convert("RGB")
    for name, size in {
        "hoard.png": 192,
        "favicon-16x16.png": 16,
        "favicon-32x32.png": 32,
        "apple-touch-icon.png": 180,
        "logo-192x192.png": 192,
        "logo-512x512.png": 512,
    }.items():
        icon.resize((size, size), Image.Resampling.LANCZOS).save(
            static / name, optimize=True
        )
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(
        static / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (256, 256)],
    )

    # Loading and login use the bundled SVG even when ui.logo is configured.
    # Keep the SVG format expected by upstream's static asset tests.
    encoded = base64.b64encode((static / "hoard.png").read_bytes()).decode()
    (static / "img" / "logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">'
        f'<image width="192" height="192" href="data:image/png;base64,{encoded}"/>'
        "</svg>\n"
    )
    index = static / "index.html"
    html = index.read_text()
    assert 'content="#f7f9fb"' in html, "upstream browser theme-color changed"
    html = html.replace('content="#f7f9fb"', 'content="#282828"')
    for url in (
        "/css/custom.css",
        "/css/app.css",
        "/js/app.js",
        "/js/chunk-vendors.js",
        "/apple-touch-icon.png",
        "/manifest.json",
    ):
        assert f'"{url}"' in html, f"upstream static URL changed: {url}"
        html = html.replace(f'"{url}"', f'"{url}?v={revision}"')
    index.write_text(html)

    manifest = static / "manifest.json"
    data = json.loads(manifest.read_text())
    data.update(
        id="hoard-status",
        name="Hoard Status",
        short_name="Hoard",
        description="Service availability across the realm.",
        theme_color="#282828",
        background_color="#282828",
    )
    for entry in data["icons"]:
        entry["src"] += f"?v={revision}"
    manifest.write_text(json.dumps(data, indent=2) + "\n")

    # Canvas charts cannot inherit CSS colors. Replace their actual literal
    # colors in the shipped bundle, in both light/dark branches. No rebuilding
    # the Node toolchain or global CSS filters that distort the supplied icon.
    bundle = static / "js" / "app.js"
    js = bundle.read_text()
    assert 'alt:"Gatus"' in js, "upstream image accessibility label changed"
    assert 'alt:"Gatus logo"' in js, "upstream loading label changed"
    js = js.replace('alt:"Gatus"', 'alt:"Hoard"').replace(
        'alt:"Gatus logo"', 'alt:"Hoard logo"'
    )
    assert "img/logo.svg" in js, "upstream loading logo URL changed"
    js = js.replace("img/logo.svg", f"img/logo.svg?v={revision}")
    palette = {
        "rgb(96, 165, 250)": "rgb(131, 165, 152)",
        "rgb(59, 130, 246)": "rgb(131, 165, 152)",
        "rgba(96, 165, 250, 0.1)": "rgba(131, 165, 152, 0.1)",
        "rgba(59, 130, 246, 0.1)": "rgba(131, 165, 152, 0.1)",
        "rgba(239, 68, 68, 0.8)": "rgba(251, 73, 52, 0.8)",
        "rgba(31, 41, 55, 0.95)": "rgba(60, 56, 54, 0.95)",
        "rgba(255, 255, 255, 0.95)": "rgba(60, 56, 54, 0.95)",
        "rgba(75, 85, 99, 0.3)": "rgba(102, 92, 84, 0.3)",
        "rgba(229, 231, 235, 0.8)": "rgba(102, 92, 84, 0.3)",
        "#f9fafb": "#ebdbb2",
        "#111827": "#ebdbb2",
        "#d1d5db": "#d5c4a1",
        "#374151": "#d5c4a1",
        "#4b5563": "#665c54",
        "#e5e7eb": "#665c54",
        "#9ca3af": "#a89984",
        "#6b7280": "#a89984",
        "#ffffff": "#ebdbb2",
    }
    for old, new in palette.items():
        assert old in js, f"upstream chart color changed: {old}"
        js = js.replace(old, new)
    bundle.write_text(js)


if __name__ == "__main__":
    brand(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
