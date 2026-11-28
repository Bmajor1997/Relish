"""Fails when two dishes in the app share a photo, or when the photo fingerprints are out of date. Standard library only.

A pair of photos whose pHashes differ in 12 bits or fewer is almost always the same picture (often cropped differently).
Pairs a person has looked at go in data/curated-photos/duplicate-review.json with a reason, a reviewer and an expiry date:
either "different photos" (they only share the studio style) or a known duplicate waiting for a replacement photo.

    python3 scripts/check_photo_duplicates.py
"""
import hashlib
import json
import sys
from datetime import date
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "apps" / "mobile" / "assets" / "collection"
PRINTS = ROOT / "data" / "curated-photos" / "fingerprints.json"
REVIEW = ROOT / "data" / "curated-photos" / "duplicate-review.json"
LIMIT = 12


def stale_fingerprints(prints, photo_dir=PHOTOS):
    """Photos with no fingerprint, a changed file, or a fingerprint for a photo that is gone."""
    files = {p.name: p for p in photo_dir.glob("*.jpg")}
    problems = [f"{name}: no fingerprint" for name in sorted(set(files) - set(prints))]
    problems += [f"{name}: fingerprint for a photo that no longer exists" for name in sorted(set(prints) - set(files))]
    for name in sorted(set(files) & set(prints)):
        if hashlib.sha256(files[name].read_bytes()).hexdigest() != prints[name]["sha256"]:
            problems.append(f"{name}: photo changed since its fingerprint was made")
    return problems


def close_pairs(prints, limit=LIMIT):
    pairs = []
    for (a, pa), (b, pb) in combinations(sorted(prints.items()), 2):
        distance = bin(int(pa["phash"], 16) ^ int(pb["phash"], 16)).count("1")
        if distance <= limit:
            pairs.append((a, b, distance))
    return pairs


def unreviewed_pairs(pairs, review, today=None):
    today = today or date.today()
    if not isinstance(review, list):
        raise ValueError("The duplicate review must be a list of reviewed photo pairs.")
    reviewed = set()
    for item in review:
        if not (isinstance(item.get("photos"), list) and len(item["photos"]) == 2
                and all(isinstance(item.get(k), str) and item[k].strip() for k in ("reason", "reviewed_by", "expires"))):
            raise ValueError("Every reviewed pair needs two photos, a reason, a reviewer and an expiry date.")
        if date.fromisoformat(item["expires"]) >= today:
            reviewed.add(frozenset(item["photos"]))
    return [p for p in pairs if frozenset(p[:2]) not in reviewed]


def main():
    if not PRINTS.exists():
        print("No photo fingerprints yet. Run: python3 scripts/make_collection.py")
        return 1
    prints = json.loads(PRINTS.read_text(encoding="utf-8"))
    review = json.loads(REVIEW.read_text(encoding="utf-8")) if REVIEW.exists() else []
    problems = stale_fingerprints(prints)
    if problems:
        print("Photo fingerprints are out of date. Run: python3 scripts/make_collection.py")
        print("\n".join(f"- {p}" for p in problems))
        return 1
    pairs = close_pairs(prints)
    left = unreviewed_pairs(pairs, review)
    print(f"{len(prints)} photos checked; {len(pairs)} look alike; {len(left)} need review.")
    for a, b, distance in left:
        print(f"- {a} and {b} look like the same photo (pHash distance {distance}). Replace one, or add the pair to "
              f"{REVIEW.relative_to(ROOT)} after checking them side by side.")
    return 1 if left else 0


if __name__ == "__main__":
    sys.exit(main())
