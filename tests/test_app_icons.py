"""Geometry checks for the bundled Tauri application icons.

macOS sizes a Dock tile from the opaque pixels of the icon, so a full-bleed
square renders noticeably larger than the system apps around it. Apple's grid
puts an 824 pt rounded body inside a 1024 pt canvas and leaves the rest
transparent; these tests lock that ratio in, plus the transparent corners, so a
future ``tauri icon`` run cannot silently restore the oversized artwork.
"""

import struct
import unittest
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"

# Apple's macOS icon grid: 824 of 1024 points, centred.
BODY_RATIO = 824 / 1024
# Tolerance covers the anti-aliased edge of the rounded body at each size.
RATIO_TOLERANCE = 0.03


def read_rgba_png(path):
    """Decode a non-interlaced 8-bit RGBA PNG into (width, height, rows)."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")

    offset = 8
    header = None
    idat = bytearray()
    while offset < len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            idat += payload
        elif kind == b"IEND":
            break

    width, height, depth, colour, _, _, interlace = header
    if (depth, colour, interlace) != (8, 6, 0):
        raise ValueError(f"{path} is not an 8-bit non-interlaced RGBA PNG")

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    rows = []
    previous = bytearray(stride)
    pos = 0
    for _ in range(height):
        filter_type = raw[pos]
        line = bytearray(raw[pos + 1 : pos + 1 + stride])
        pos += 1 + stride
        for i in range(stride):
            left = line[i - 4] if i >= 4 else 0
            up = previous[i]
            upper_left = previous[i - 4] if i >= 4 else 0
            if filter_type == 1:
                line[i] = (line[i] + left) & 0xFF
            elif filter_type == 2:
                line[i] = (line[i] + up) & 0xFF
            elif filter_type == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif filter_type == 4:
                p = left + up - upper_left
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upper_left)
                if pa <= pb and pa <= pc:
                    predictor = left
                elif pb <= pc:
                    predictor = up
                else:
                    predictor = upper_left
                line[i] = (line[i] + predictor) & 0xFF
            elif filter_type != 0:
                raise ValueError(f"unsupported PNG filter {filter_type}")
        rows.append(bytes(line))
        previous = line
    return width, height, rows


def alpha_at(rows, x, y):
    return rows[y][x * 4 + 3]


def opaque_bounds(width, height, rows):
    """Bounding box of pixels that are more than marginally opaque."""
    xs = []
    ys = []
    for y in range(height):
        row = rows[y]
        for x in range(width):
            if row[x * 4 + 3] > 8:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


class AppIconGeometryTests(unittest.TestCase):
    icon_names = ("icon.png", "128x128@2x.png", "128x128.png")

    def test_icon_corners_are_transparent(self):
        for name in self.icon_names:
            with self.subTest(icon=name):
                width, height, rows = read_rgba_png(ICON_DIR / name)
                corners = (
                    (0, 0),
                    (width - 1, 0),
                    (0, height - 1),
                    (width - 1, height - 1),
                )
                for x, y in corners:
                    self.assertEqual(
                        alpha_at(rows, x, y),
                        0,
                        f"{name} corner ({x}, {y}) is not transparent",
                    )

    def test_icon_body_matches_the_macos_grid(self):
        for name in self.icon_names:
            with self.subTest(icon=name):
                width, height, rows = read_rgba_png(ICON_DIR / name)
                left, top, right, bottom = opaque_bounds(width, height, rows)

                self.assertAlmostEqual(
                    (right - left + 1) / width,
                    BODY_RATIO,
                    delta=RATIO_TOLERANCE,
                    msg=f"{name} body is not {BODY_RATIO:.0%} of the canvas width",
                )
                self.assertAlmostEqual(
                    (bottom - top + 1) / height,
                    BODY_RATIO,
                    delta=RATIO_TOLERANCE,
                    msg=f"{name} body is not {BODY_RATIO:.0%} of the canvas height",
                )
                self.assertAlmostEqual(
                    left, width - 1 - right, delta=1, msg=f"{name} body is off-centre"
                )
                self.assertAlmostEqual(
                    top, height - 1 - bottom, delta=1, msg=f"{name} body is off-centre"
                )


if __name__ == "__main__":
    unittest.main()
