"""Generates customize/splash.png, Matrix-style digital rain for the box's boot
and Kodi splash screens. Both draw into a 1920x1080 framebuffer. Run from the
repo root:

  nix shell --impure --expr '(builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux.python3.withPackages (p: [p.pillow])' \\
    -c python3 scripts/kodi/splash.py \\
    "$(nix build --no-link --print-out-paths nixpkgs#noto-fonts-cjk-sans)/share/fonts/opentype/noto-cjk/NotoSansMonoCJK-VF.otf.ttc"
"""

import random
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

# Drawn at twice the output size, which smooths the glyphs and their glow.
WIDTH, HEIGHT = 3840, 2160
FONT_SIZE = 52
COLUMN_PITCH = 40
ROW_PITCH = 56
SEED = 1999
# Mirrored half-width katakana, with digits and a few symbols, as in the film.
KATAKANA = [chr(c) for c in range(0xFF66, 0xFF9E)]
GLYPHS = KATAKANA + list("0123456789Z:.=*+-<>|")
OUT = Path(__file__).resolve().parent / "customize" / "splash.png"


def glyph_masks(font):
    """Each glyph as a white-on-black mask, one column pitch wide."""
    masks = {}
    for glyph in GLYPHS:
        mask = Image.new("L", (COLUMN_PITCH, ROW_PITCH))
        ImageDraw.Draw(mask).text(
            (COLUMN_PITCH / 2, ROW_PITCH / 2), glyph, fill=255, font=font, anchor="mm"
        )
        masks[glyph] = ImageOps.mirror(mask) if glyph in KATAKANA else mask
    return masks


def colour(distance, length, dim):
    """A trail cell's colour: white at the head, fading green behind it."""
    if distance == 0:
        return (225, 255, 225)
    if distance == 1:
        return (150, 255, 160)
    fade = (1 - distance / length) ** 1.6 * dim
    return (int(30 * fade), int(255 * fade), int(70 * fade))


def rain(masks, rng):
    image = Image.new("RGB", (WIDTH, HEIGHT))
    rows = HEIGHT // ROW_PITCH + 1
    for column in range(WIDTH // COLUMN_PITCH):
        dim = rng.uniform(0.35, 1.0)
        streams = rng.choices((0, 1, 2), weights=(15, 55, 30))[0]
        for _ in range(streams):
            head = rng.randint(-4, rows + 12)
            length = rng.randint(6, 28)
            for distance in range(length):
                row = head - distance
                if not 0 <= row < rows or rng.random() < 0.06:
                    continue
                image.paste(
                    colour(distance, length, dim),
                    (column * COLUMN_PITCH, row * ROW_PITCH),
                    masks[rng.choice(GLYPHS)],
                )
        # A few faint stray glyphs between the streams.
        for _ in range(rng.randint(0, 3)):
            image.paste(
                (0, int(70 * dim), int(20 * dim)),
                (column * COLUMN_PITCH, rng.randrange(rows) * ROW_PITCH),
                masks[rng.choice(GLYPHS)],
            )
    return image


def bloom(image):
    """The phosphor glow around bright glyphs."""
    near = image.filter(ImageFilter.GaussianBlur(6)).point(lambda v: v * 0.9)
    far = image.filter(ImageFilter.GaussianBlur(28)).point(lambda v: v * 0.5)
    return ImageChops.add(ImageChops.add(image, near), far)


def main():
    # Face 0 of the collection is Noto Sans Mono CJK JP.
    font = ImageFont.truetype(sys.argv[1], FONT_SIZE, index=0)
    font.set_variation_by_name("Medium")
    image = bloom(rain(glyph_masks(font), random.Random(SEED)))
    image.resize((WIDTH // 2, HEIGHT // 2), Image.LANCZOS).save(OUT, optimize=True)


if __name__ == "__main__":
    main()
