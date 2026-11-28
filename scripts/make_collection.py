"""Builds the collection that ships inside the app, so the Home wall, Explore and their recipes work offline.

Run from the repo root after adding photos or editing recipes:
    python3 scripts/build_recipes.py
    python3 scripts/make_collection.py

It writes:
  apps/mobile/assets/collection/<file>.jpg     one phone-sized photo per dish (480 px square)
  apps/mobile/src/recipes/collection.json      every hand-written recipe, keyed by file name
  apps/mobile/src/recipes/collectionPhotos.ts  the dishes, their names and photos (bundled with require)
  apps/mobile/src/ui/wallPhotos.ts             the two rows of the Home photo wall
  data/curated-photos/fingerprints.json        hashes of the app photos, for scripts/check_photo_duplicates.py
"""
import json
from pathlib import Path

from PIL import Image

from photo_fingerprints import write_fingerprints

ROOT = Path(__file__).resolve().parent.parent
CURATED = ROOT / "data" / "curated-photos"
APP = ROOT / "apps" / "mobile"
OUT = APP / "assets" / "collection"
SIZE = 480

# Two rows for the Home wall, meals and drinks mixed so each row has variety.
WALL_ROWS = [
    ["ramen", "aperol-spritz", "chicken-tikka-masala", "cosmopolitan", "pepperoni-pizza", "mojito", "pho", "negroni"],
    ["old-fashioned", "paella", "margarita", "fish-tacos", "espresso-martini", "lasagna", "blue-hawaii", "shrimp-scampi-pasta"],
]

manifest = json.loads((CURATED / "manifest.json").read_text())
recipes = json.loads((ROOT / "data" / "recipes" / "recipes.json").read_text())
# Photos marked "hidden" (wrong or missing image) stay out of the app until they are replaced.
photos = [p for p in manifest["photos"] if not p.get("hidden")]
stems = [p["file"][:-4] for p in photos]
missing = [s for s in stems if s not in recipes]
if missing:
    raise SystemExit(f"These photos have no recipe yet; run build_recipes.py first: {' '.join(missing)}")

OUT.mkdir(parents=True, exist_ok=True)
for old in OUT.glob("*.jpg"):
    if old.stem not in stems:
        old.unlink()
for p, stem in zip(photos, stems):
    target = OUT / f"{stem}.jpg"
    source = CURATED / p["file"]
    if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
        continue
    im = Image.open(source).convert("RGB")
    side = min(im.size)
    left, top = (im.width - side) // 2, (im.height - side) // 2
    im.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.LANCZOS).save(
        target, "JPEG", quality=62, optimize=True, progressive=True
    )

# Vegetarian and vegan versions, for the "Make it" chips: a recipe, or "same" when the regular one already fits.
(APP / "src" / "recipes" / "collectionVariants.json").write_text(
    json.dumps({s: recipes[s]["variants"] for s in stems if recipes[s].get("variants")}, ensure_ascii=False, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
(APP / "src" / "recipes" / "collection.json").write_text(
    json.dumps({s: recipes[s]["recipe"] for s in stems}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
)

entries = "".join(
    f'  {{ id: {json.dumps(s)}, name: {json.dumps(p["names"][0])}, kind: "{p["kind"]}", aliases: {json.dumps(p["names"][1:], ensure_ascii=False)}, '
    f'source: require("../../assets/collection/{s}.jpg") }},\n'
    for p, s in zip(photos, stems)
)
(APP / "src" / "recipes" / "collectionPhotos.ts").write_text(
    "// Made by scripts/make_collection.py from data/curated-photos. Do not edit by hand; run the script.\n\n"
    'import type { Kind } from "./types";\n\n'
    "/** One dish in the bundled collection: its id (the photo's file name), names and photo. */\n"
    "export type CollectionDish = { id: string; name: string; kind: Kind; aliases: string[]; source: number };\n\n"
    f"export const COLLECTION: CollectionDish[] = [\n{entries}];\n",
    encoding="utf-8",
)

by_stem = dict(zip(stems, photos))
rows_ts = ",\n".join(
    "  [\n" + "".join(
        f'    {{ name: {json.dumps(by_stem[s]["names"][0])}, kind: "{by_stem[s]["kind"]}", source: require("../../assets/collection/{s}.jpg") }},\n'
        for s in row) + "  ]"
    for row in WALL_ROWS
)
(APP / "src" / "ui" / "wallPhotos.ts").write_text(
    "// Made by scripts/make_collection.py from data/curated-photos. Do not edit by hand; run the script.\n\n"
    "/** How many hand-picked cover photos the app has. */\n"
    f"export const CURATED_COUNT = {len(photos)};\n\n"
    "/** One photo on the wall: the dish it shows, and the bundled picture. */\n"
    'export type WallPhoto = { name: string; kind: "meal" | "cocktail"; source: number };\n\n'
    "/** The two rows of photos on the Home screen's moving photo wall. */\n"
    f"export const WALL_ROWS: WallPhoto[][] = [\n{rows_ts},\n];\n",
    encoding="utf-8",
)
size = sum(f.stat().st_size for f in OUT.glob("*.jpg"))
print(f"{len(stems)} dishes bundled; photos {size / 1e6:.1f} MB")

write_fingerprints()
