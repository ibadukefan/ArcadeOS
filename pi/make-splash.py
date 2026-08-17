#!/usr/bin/env python3
"""
Generate the ArcadeOS Plymouth wordmark as a PNG.

Written against the Python standard library only — no Pillow, no ImageMagick,
no fontconfig. A fresh Raspberry Pi OS Lite install has none of those, and
pulling in a rendering stack just to draw six letters at install time would be
a poor trade on a 2GB Pi.

The letterforms are a 5x7 block font defined below and drawn as filled
rectangles. That is not a compromise: chunky pixel letterforms are exactly
right for an arcade cabinet, and they scale to any size crisply.

Colours come from the ArcadeOS aurora ramp, applied as a horizontal gradient
across the whole wordmark: #37E1C4 -> #8B7BF0 -> #F06CC9 on #07050E.

Usage:
    make-splash.py OUTPUT.png [--width 900] [--scale N]
"""

import struct
import sys
import zlib

# --- design tokens, mirrored from src/core/util.js ---------------------------
BG = (0x07, 0x05, 0x0E)
AURORA = [(0x37, 0xE1, 0xC4), (0x8B, 0x7B, 0xF0), (0xF0, 0x6C, 0xC9)]
DIM = (0x6E, 0x6A, 0xA0)

# --- 5x7 block font ----------------------------------------------------------
# Only the glyphs the wordmark needs. Each row is five bits, MSB first.
GLYPHS = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "S": ["01111", "10000", "10000", "01110", "00001", "10001", "01110"],
    " ": ["00000"] * 7,
}

GLYPH_W = 5
GLYPH_H = 7


class Canvas:
    """A tiny RGB canvas that can write itself out as a PNG."""

    def __init__(self, width, height, fill):
        self.w = width
        self.h = height
        self.px = bytearray()
        for _ in range(height):
            self.px.extend(bytes(fill) * width)

    def set(self, x, y, rgb):
        if x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        i = (y * self.w + x) * 3
        self.px[i] = rgb[0]
        self.px[i + 1] = rgb[1]
        self.px[i + 2] = rgb[2]

    def rect(self, x, y, w, h, rgb):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.set(xx, yy, rgb)

    def png(self):
        raw = bytearray()
        stride = self.w * 3
        for y in range(self.h):
            raw.append(0)  # filter type 0 (None)
            raw.extend(self.px[y * stride:(y + 1) * stride])

        def chunk(tag, data):
            out = struct.pack(">I", len(data)) + tag + data
            return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        header = struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )


def ramp(t):
    """Sample the three-stop aurora gradient at 0..1."""
    t = max(0.0, min(1.0, t))
    if t <= 0.5:
        a, b, k = AURORA[0], AURORA[1], t / 0.5
    else:
        a, b, k = AURORA[1], AURORA[2], (t - 0.5) / 0.5
    return tuple(int(round(a[i] + (b[i] - a[i]) * k)) for i in range(3))


def text_width(s, scale, track):
    if not s:
        return 0
    return len(s) * (GLYPH_W * scale + track) - track


def draw_text(canvas, s, x, y, scale, track, colour):
    """Draw `s` with each lit pixel as a scale x scale block."""
    cursor = x
    for ch in s.upper():
        glyph = GLYPHS.get(ch)
        if glyph is None:
            cursor += GLYPH_W * scale + track
            continue
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit != "1":
                    continue
                px = cursor + col * scale
                py = y + row * scale
                if callable(colour):
                    # Gradient sampled per block, across the whole canvas.
                    rgb = colour(px / max(1, canvas.w - 1))
                else:
                    rgb = colour
                canvas.rect(px, py, scale, scale, rgb)
        cursor += GLYPH_W * scale + track
    return cursor


def build(target_width=900):
    word = "ARCADE"
    suffix = "OS"

    # Pick the block size that fills the requested width, leaving a margin.
    usable = int(target_width * 0.86)
    scale = max(2, usable // (len(word) * (GLYPH_W + 2)))
    track = scale * 2

    main_w = text_width(word, scale, track)
    sub_scale = max(1, scale // 2)
    sub_track = sub_scale * 2
    sub_w = text_width(suffix, sub_scale, sub_track)

    gap = scale * 3
    total_w = main_w + gap + sub_w
    width = total_w + scale * 6
    height = GLYPH_H * scale + scale * 6

    canvas = Canvas(width, height, BG)
    x0 = (width - total_w) // 2
    y0 = (height - GLYPH_H * scale) // 2

    # Wordmark in the aurora ramp, "OS" in the dim token — same as the shell.
    end = draw_text(canvas, word, x0, y0, scale, track, ramp)
    draw_text(
        canvas,
        suffix,
        end - track + gap,
        y0 + (GLYPH_H * scale - GLYPH_H * sub_scale),
        sub_scale,
        sub_track,
        DIM,
    )
    return canvas


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: make-splash.py OUTPUT.png [--width N]\n")
        return 2
    out = argv[1]
    width = 900
    if "--width" in argv:
        try:
            width = int(argv[argv.index("--width") + 1])
        except (ValueError, IndexError):
            sys.stderr.write("--width needs a number\n")
            return 2

    canvas = build(width)
    with open(out, "wb") as fh:
        fh.write(canvas.png())
    sys.stdout.write("wrote %s (%dx%d)\n" % (out, canvas.w, canvas.h))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
