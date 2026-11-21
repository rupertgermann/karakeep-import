#!/usr/bin/env python3
"""Regenerate the Karakeep Transfer application icon set.

The bundled artwork used to be a full-bleed square: the green mark touched every
edge of the canvas and the corners outside the rounded shape were opaque white.
On macOS that makes the Dock tile look oversized next to system apps, because
Apple's icon grid expects the rounded body to occupy 824 of a 1024 pt canvas
with transparent padding around it.

This script rebuilds every raster icon from ``assets/brand-mark.png`` on that
grid: a crisp squircle body, transparent corners and margins, and the glyph
re-composited on top.

Usage:  python3 scripts/generate-app-icons.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "brand-mark.png"
ICON_DIR = ROOT / "src-tauri" / "icons"

# Apple's macOS icon grid: a 1024 canvas with an 824 rounded body centred in it.
CANVAS = 1024
BODY = 824
# Superellipse exponent that approximates the macOS "squircle" corner.
SQUIRCLE_EXPONENT = 5.0
# Supersampling factor used for anti-aliasing before the final downscale.
SS = 4

GREEN = (67, 94, 72, 255)
CREAM = (248, 240, 229, 255)
ORANGE = (228, 171, 74, 255)

# Luminance ramp separating the dark green backdrop from the light glyph.
GLYPH_LO = 120.0
GLYPH_HI = 150.0

PNG_SIZES = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}

ICNS_SIZES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def squircle_mask(size: int, exponent: float) -> Image.Image:
    """Render an anti-aliased superellipse mask filling ``size`` x ``size``."""
    hi = size * SS
    half = hi / 2.0
    axis = (np.arange(hi) + 0.5 - half) / half
    field = np.abs(axis)[None, :] ** exponent + np.abs(axis)[:, None] ** exponent
    mask = Image.fromarray(np.where(field <= 1.0, 255, 0).astype(np.uint8), "L")
    return mask.resize((size, size), Image.LANCZOS)


def build_glyph(body: int) -> Image.Image:
    """Extract the cream/orange mark from the source art as an RGBA layer."""
    hi = body * SS
    src = Image.open(SOURCE).convert("RGB").resize((hi, hi), Image.LANCZOS)
    rgb = np.asarray(src).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]

    # Re-threshold the luminance ramp so the upscaled edges stay crisp instead
    # of inheriting the blur of the low-resolution source.
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    alpha = np.clip((lum - GLYPH_LO) / (GLYPH_HI - GLYPH_LO), 0.0, 1.0)

    # The source art is full-bleed, so its own corners sit outside the rounded
    # body and are pure white. Ignore anything beyond the central 76%.
    inset = int(hi * 0.12)
    keep = np.zeros_like(alpha, dtype=bool)
    keep[inset : hi - inset, inset : hi - inset] = True
    alpha = np.where(keep, alpha, 0.0)

    # Snap to the two brand tones so upscaling cannot muddy them.
    is_orange = (r - b) > 70
    out = np.zeros((hi, hi, 4), dtype=np.uint8)
    for channel in range(3):
        out[..., channel] = np.where(is_orange, ORANGE[channel], CREAM[channel])
    out[..., 3] = np.round(alpha * 255).astype(np.uint8)

    return Image.fromarray(out, "RGBA").resize((body, body), Image.LANCZOS)


def build_master() -> Image.Image:
    body = Image.new("RGBA", (BODY, BODY), GREEN)
    body.putalpha(squircle_mask(BODY, SQUIRCLE_EXPONENT))
    body.alpha_composite(build_glyph(BODY))

    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = (CANVAS - BODY) // 2
    master.paste(body, (offset, offset))
    return master


def resized(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)


def write_icns(master: Image.Image, target: Path) -> None:
    if not shutil.which("iconutil"):
        print("iconutil not found - skipping icon.icns", file=sys.stderr)
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for name, size in ICNS_SIZES:
            resized(master, size).save(iconset / name)
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset), "-o", str(target)],
            check=True,
        )


def main() -> int:
    if not SOURCE.exists():
        print(f"missing source artwork: {SOURCE}", file=sys.stderr)
        return 1

    master = build_master()

    for name, size in PNG_SIZES.items():
        resized(master, size).save(ICON_DIR / name)

    resized(master, 256).save(
        ICON_DIR / "icon.ico",
        sizes=[(s, s) for s in ICO_SIZES],
    )
    write_icns(master, ICON_DIR / "icon.icns")

    print(f"regenerated {len(PNG_SIZES) + 2} icon files in {ICON_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
