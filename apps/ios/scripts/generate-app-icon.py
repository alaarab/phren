#!/usr/bin/env python3
"""Render the 1024x1024 iOS app icon from the hi-res mascot.

Source is docs/phren-transparent.png (the site's mascot with face and
sparkle), not the 24-pixel sprite: cropped to its alpha bounds, scaled to
86% of the tile, centred slightly low on the brand navy, flattened to RGB.
iOS masks the corners itself, so the asset is a plain opaque square.

    python3 apps/ios/scripts/generate-app-icon.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "docs/phren-transparent.png"
OUT = ROOT / "apps/ios/Phren/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
SIZE = 1024
NAVY = (0x12, 0x12, 0x2A, 255)
HEIGHT_RATIO = 0.86
CENTER_Y = 0.53

mascot = Image.open(SOURCE).convert("RGBA")
mascot = mascot.crop(mascot.getbbox())
height = round(SIZE * HEIGHT_RATIO)
width = round(mascot.width * height / mascot.height)
mascot = mascot.resize((width, height), Image.LANCZOS)

tile = Image.new("RGBA", (SIZE, SIZE), NAVY)
tile.alpha_composite(mascot, (SIZE // 2 - width // 2, round(SIZE * CENTER_Y) - height // 2))
tile.convert("RGB").save(OUT, optimize=True)
print(f"wrote {OUT.relative_to(ROOT)} ({width}x{height} mascot on {SIZE}x{SIZE})")
