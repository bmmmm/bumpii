#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Turn the static logo export into the bouncing loop used in the README.

Run:  uvx --from pillow python assets/make-logo-gif.py

Takes assets/logo-source.png (the flat export), lifts the capsule mascot out of
it, and animates that one piece: the wordmark stays put while the capsule
hops. Squash-and-stretch on the landing and a shadow that shrinks with height
are what make a bounce read as weight rather than as a sprite sliding up and
down — without them it looks like a bug, not a character.

Deliberately regenerable rather than a hand-made binary: the source PNG can be
re-exported from Canva and this script re-run, instead of the GIF becoming an
artifact nobody can reproduce.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = HERE / "logo-source.png"
OUT = HERE / "logo.gif"

# Region of logo-source.png holding the capsule mascot, and the crop that keeps
# the composition tight. Both are measured against the 1024x1024 export; if the
# source is ever re-exported at a different size or layout, re-measure these.
CAPSULE_BOX = (718, 372, 884, 600)
# Top edge leaves headroom for the jump: at JUMP_PX the capsule clears the
# frame by ~25px, so the apex reads as airborne rather than as clipped.
CROP_BOX = (232, 316, 916, 640)

FRAMES = 24
FRAME_MS = 60
JUMP_PX = 40  # peak height, in source pixels
SCALE = 2  # supersample factor; the GIF is downscaled at the end
OUT_WIDTH = 560  # README display size — no point shipping pixels nobody sees


def background_colour(img: Image.Image) -> tuple[int, int, int]:
    """The flat cream field — sampled from a corner, not hardcoded, so a
    re-export with a different background still erases cleanly."""
    return img.convert("RGB").getpixel((4, 4))


def bounce(t: float) -> float:
    """Height in 0..1 over a 0..1 loop.

    Not a sine: a real bounce spends most of its time in the air and almost
    none on the ground, so the contact reads as an impact. `sin(pi*t)` raised
    to a power under 1 keeps the arc but sharpens the landing.
    """
    return math.sin(math.pi * t) ** 0.72


def build() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC} — export the logo from Canva first")

    src = Image.open(SRC).convert("RGBA")
    bg = background_colour(src)

    capsule = src.crop(CAPSULE_BOX)
    cw, ch = capsule.size

    # The plate is the logo with the capsule painted out, so the mascot can be
    # drawn back at a moving position without leaving a copy behind.
    plate = src.copy()
    plate.paste(Image.new("RGBA", (cw, ch), (*bg, 255)), CAPSULE_BOX[:2])

    big = (plate.width * SCALE, plate.height * SCALE)
    plate_big = plate.resize(big, Image.LANCZOS)
    ground_y = CAPSULE_BOX[1] * SCALE
    cx = CAPSULE_BOX[0] * SCALE

    frames: list[Image.Image] = []
    for i in range(FRAMES):
        t = i / FRAMES
        h = bounce(t)
        frame = plate_big.copy()

        # Squash on contact, stretch just after take-off and before landing.
        # Volume is roughly preserved (widen as it flattens) or the character
        # visibly changes size instead of deforming.
        if h < 0.12:
            squash = 1.0 - (0.12 - h) * 1.4  # < 1 → flatter
        else:
            squash = 1.0 + min(h, 0.5) * 0.10  # > 1 → taller
        sh = max(0.60, min(1.14, squash))
        sw = 1.0 / (sh**0.55)

        w2 = max(1, int(cw * SCALE * sw))
        h2 = max(1, int(ch * SCALE * sh))
        sprite = capsule.resize((w2, h2), Image.LANCZOS)

        # Feet stay on the same line: taller sprites grow upward, and the whole
        # thing lifts by the bounce height.
        lift = int(JUMP_PX * SCALE * h)
        y = ground_y + (ch * SCALE - h2) - lift
        x = cx - (w2 - cw * SCALE) // 2

        # Contact shadow: shrinks and fades with height. Drawn on the plate,
        # under the sprite.
        shadow_w = int(cw * SCALE * (0.62 - 0.28 * h))
        shadow_h = max(2, int(9 * SCALE * (1.0 - 0.55 * h)))
        if shadow_w > 2:
            shadow = Image.new("RGBA", (shadow_w, shadow_h), (0, 0, 0, 0))
            alpha = int(46 * (1.0 - 0.62 * h))
            from PIL import ImageDraw

            ImageDraw.Draw(shadow).ellipse((0, 0, shadow_w - 1, shadow_h - 1), fill=(60, 50, 40, alpha))
            sx = cx + (cw * SCALE - shadow_w) // 2
            sy = ground_y + ch * SCALE - shadow_h // 2
            frame.alpha_composite(shadow, (sx, sy))

        frame.alpha_composite(sprite, (x, y))
        crop = frame.crop(tuple(v * SCALE for v in CROP_BOX))
        out_h = round(OUT_WIDTH * crop.height / crop.width)
        frames.append(crop.resize((OUT_WIDTH, out_h), Image.LANCZOS).convert("RGB"))

    # One shared palette for every frame. Per-frame palettes make each frame a
    # full-colour image and roughly double the file; the artwork is flat enough
    # that 64 colours hold it without visible banding.
    palette = frames[0].quantize(colors=64, method=Image.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]

    quantized[0].save(
        OUT,
        save_all=True,
        append_images=quantized[1:],
        duration=FRAME_MS,
        loop=0,
        optimize=True,
    )
    kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT.relative_to(HERE.parent)} — {len(frames)} frames, {frames[0].size[0]}x{frames[0].size[1]}, {kb:.0f} KB")


if __name__ == "__main__":
    build()
