#!/usr/bin/env python3
"""Render the 1024x1024 iOS app icon from the hi-res mascot.

Source is docs/phren-transparent.png (the site's mascot), not the 24-pixel
sprite. The cyan sparkle is dropped so only the character remains; the body
keeps the scale it had with the sparkle in frame (86% of the tile for the
full figure) and sits centred on the brand navy, flattened to RGB. iOS masks
the corners itself, so the asset is a plain opaque square.

    python3 apps/ios/scripts/generate-app-icon.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "docs/phren-transparent.png"
OUT = ROOT / "apps/ios/Phren/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
SIZE = 1024
NAVY = (0x12, 0x12, 0x2A, 255)
FIGURE_HEIGHT_RATIO = 0.86


def without_sparkle(image):
    """Clear every opaque blob that is not the body — the sparkle and its
    anti-aliased fringe, which no colour test separates cleanly."""
    width, height = image.size
    alpha = image.getchannel("A").load()
    seen = bytearray(width * height)
    keep = Image.new("L", image.size, 0)
    keep_px = keep.load()
    best = None
    for start_y in range(height):
        for start_x in range(width):
            if alpha[start_x, start_y] == 0 or seen[start_y * width + start_x]:
                continue
            blob, stack = [], [(start_x, start_y)]
            seen[start_y * width + start_x] = 1
            while stack:
                x, y = stack.pop()
                blob.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < width and 0 <= ny < height and alpha[nx, ny] and not seen[ny * width + nx]:
                        seen[ny * width + nx] = 1
                        stack.append((nx, ny))
            if best is None or len(blob) > len(best):
                best = blob
    for x, y in best:
        keep_px[x, y] = 255
    body = Image.new("RGBA", image.size, (0, 0, 0, 0))
    body.paste(image, mask=keep)
    return body


source = Image.open(SOURCE).convert("RGBA")
figure = source.crop(source.getbbox())
scale = SIZE * FIGURE_HEIGHT_RATIO / figure.height

body = without_sparkle(figure)
body = body.crop(body.getbbox())
width, height = round(body.width * scale), round(body.height * scale)
body = body.resize((width, height), Image.LANCZOS)

tile = Image.new("RGBA", (SIZE, SIZE), NAVY)
tile.alpha_composite(body, ((SIZE - width) // 2, (SIZE - height) // 2))
tile.convert("RGB").save(OUT, optimize=True)
print(f"wrote {OUT.relative_to(ROOT)} ({width}x{height} body on {SIZE}x{SIZE})")
