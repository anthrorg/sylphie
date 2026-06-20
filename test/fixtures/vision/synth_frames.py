"""synth_frames.py — deterministic synthetic JPEG fixture generator.

Generates labeled-rectangle JPEG files so acceptance tests can run without a
live camera.  Each frame is a solid background with a filled rectangle (the
"object") and a text label, seeded from the filename so every run produces the
same bytes.

Output files (all written relative to this script's directory):
  mug_640x480.jpg
  book_640x480.jpg
  person_640x480.jpg
  mug_1280x720.jpg

Usage::

    python test/fixtures/vision/synth_frames.py

Requires only ``Pillow`` (standard install; available in the project venv).
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Output directory is the same folder this script lives in.
OUT_DIR = Path(__file__).parent

# Frame specs: (label, width, height)
_SPECS: list[tuple[str, int, int]] = [
    ("mug", 640, 480),
    ("book", 640, 480),
    ("person", 640, 480),
    ("mug", 1280, 720),
]


def _seed_color(label: str, width: int, height: int, salt: str) -> tuple[int, int, int]:
    """Deterministic RGB from label + dims + salt so each frame is visually distinct."""
    digest = hashlib.md5(f"{label}-{width}x{height}-{salt}".encode()).digest()
    return int(digest[0]), int(digest[1]), int(digest[2])


def make_frame(label: str, width: int, height: int) -> Image.Image:
    """Build a synthetic JPEG frame: solid background + labeled rectangle."""
    bg_color = _seed_color(label, width, height, "bg")
    rect_color = _seed_color(label, width, height, "rect")

    img = Image.new("RGB", (width, height), color=bg_color)
    draw = ImageDraw.Draw(img)

    # Rectangle sized to ~40% of the frame, centred.
    margin_x = int(width * 0.30)
    margin_y = int(height * 0.30)
    x0, y0 = margin_x, margin_y
    x1, y1 = width - margin_x, height - margin_y
    draw.rectangle([x0, y0, x1, y1], fill=rect_color, outline=(255, 255, 255), width=4)

    # Label text in the upper-left of the rectangle.
    text = label.upper()
    # Use the default bitmap font — no file-system font path needed.
    try:
        font = ImageFont.load_default(size=max(20, height // 20))
    except TypeError:
        # Older Pillow (<= 9.x) does not accept the ``size`` kwarg.
        font = ImageFont.load_default()
    draw.text((x0 + 8, y0 + 8), text, fill=(255, 255, 255), font=font)

    return img


def generate_all(out_dir: Path = OUT_DIR) -> None:
    """Generate all fixture frames and write them to *out_dir*."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for label, width, height in _SPECS:
        filename = f"{label}_{width}x{height}.jpg"
        path = out_dir / filename
        img = make_frame(label, width, height)
        img.save(path, format="JPEG", quality=90)
        print(f"  wrote {path.relative_to(out_dir.parent.parent.parent) if out_dir.parts else path}")


if __name__ == "__main__":
    generate_all()
    print("Done.")
