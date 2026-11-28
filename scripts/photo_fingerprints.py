"""Writes data/curated-photos/fingerprints.json: a content hash and a perceptual hash for every photo in the app.

make_collection.py runs this after it makes the app photos, so you don't normally run it yourself. The perceptual hash
(the standard 64-bit pHash) lets scripts/check_photo_duplicates.py spot the same photo used for two dishes, even after a
different crop, without needing Pillow in CI.

    python3 scripts/photo_fingerprints.py
"""
import hashlib
import json
import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "apps" / "mobile" / "assets" / "collection"
OUT = ROOT / "data" / "curated-photos" / "fingerprints.json"
N = 32
COS = [[math.cos(math.pi * (2 * x + 1) * u / (2 * N)) for x in range(N)] for u in range(N)]


def phash(path):
    """64-bit pHash: grayscale 32x32, 2D DCT, the 8x8 lowest frequencies compared with their median."""
    image = Image.open(path).convert("L").resize((N, N), Image.LANCZOS)
    pixels = list(image.getdata())
    rows = [pixels[r * N:(r + 1) * N] for r in range(N)]
    by_row = [[sum(row[x] * COS[u][x] for x in range(N)) for u in range(8)] for row in rows]
    coefficients = [sum(by_row[y][u] * COS[v][y] for y in range(N)) for v in range(8) for u in range(8)]
    ordered = sorted(coefficients)
    median = (ordered[31] + ordered[32]) / 2
    return sum(1 << i for i, c in enumerate(coefficients) if c > median)


def write_fingerprints():
    prints = {}
    for path in sorted(PHOTOS.glob("*.jpg")):
        prints[path.name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "phash": f"{phash(path):016x}"}
    OUT.write_text(json.dumps(prints, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return len(prints)


if __name__ == "__main__":
    print(f"{write_fingerprints()} photo fingerprints written to {OUT.relative_to(ROOT)}")
