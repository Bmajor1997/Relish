"""Builds data/recipes/recipes.json from the hand-written recipe files in data/recipes/src/.

Each source file holds recipes in a compact text form:

    @ file-stem | Title | servings | prep minutes | cook minutes | allergens, comma separated | Description
    - amount | unit | ingredient
    # step
    G glass | garnish | y or n (alcoholic) | non-alcoholic version, or -     (cocktails only)
    ! note                                                                    (optional)
    T tip: why a step works or what to look for                               (optional, up to 8)
    S make-ahead and storage                                                  (optional)
    V variation                                                               (optional, up to 6)

A recipe can be followed by its vegetarian and vegan versions, which the recipe screen's "Make it" chips show
without asking the server:

    @@ vegan | Title | prep minutes | cook minutes | allergens | Description
    ~ old text => new text      swap applied to the regular recipe's ingredients, steps, tips and notes (any number)
    - / # / G / T / S / V       optional: any of these lines replace that whole part of the regular recipe
    @@ vegetarian = same        the regular recipe already is vegetarian (or vegan)
    @@ vegan = vegetarian       the vegetarian version is already vegan (its title says "Vegan" instead)

A version keeps no variations unless it gives its own V lines. A recipe that has one version must have both. After the swaps the builder rejects a version that still names
meat, fish or (for vegan) dairy, eggs or honey.

Run from the repo root:  python3 scripts/build_recipes.py
It checks every recipe against the app's rules and the photo manifest, and refuses to write if anything is wrong.

Recipes still waiting for a cover photo go in data/recipes/pending/ in the same format. They get every check and are
written to recipes.json, but the app only shows dishes with a photo, so they appear once their photo is in the manifest.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "recipes" / "src"
PENDING = ROOT / "data" / "recipes" / "pending"
OUT = ROOT / "data" / "recipes" / "recipes.json"
ALLERGENS = {"milk", "eggs", "fish", "shellfish", "tree nuts", "peanuts", "wheat", "soy", "sesame"}
NOTES = {
    "meal": "A representative home version. Restaurants and regions make it in many ways, and this isn't any one restaurant's recipe.",
    "cocktail": "A classic home version. Bars vary the proportions, and this isn't any one bar's recipe. Please drink responsibly.",
}

manifest = json.loads((ROOT / "data" / "curated-photos" / "manifest.json").read_text())
kinds = {p["file"][:-4]: p["kind"] for p in manifest["photos"]}
problems, recipes = [], {}
DIET_NAMES = ("vegetarian", "vegan")
# Words that must not appear in a version once swapped (checked on whole words, ingredient items and steps).
NOT_VEGETARIAN = ["chicken", "beef", "pork", "lamb", "mutton", "goat", "bacon", "ham", "sausage", "chorizo", "kielbasa", "salami",
                  "fish", "salmon", "tuna", "anchov", "shrimp", "prawn", "crab", "conch", "squid", "tripe", "oxtail", "gelatin",
                  "veal", "turkey", "duck", "lard", "fish sauce", "oyster sauce", "dashi", "bonito", "catfish", "mackerel",
                  # Made with animal rennet by tradition (Parmesan by law): use a vegetarian hard cheese instead.
                  "parmesan", "parmigiano", "pecorino", "grana padano", "cotija"]
NOT_VEGAN = NOT_VEGETARIAN + ["egg", "milk", "butter", "cream", "cheese", "yogurt", "yoghurt", "honey", "ghee", "ricotta",
                              "parmesan", "pecorino", "feta", "paneer", "sour cream", "crème", "mayonnaise", "whey"]
PLANT_OK = ["coconut milk", "coconut cream", "oat milk", "soy milk", "almond milk", "vegan butter", "vegan cheese", "vegan",
            "plant-based", "aquafaba", "eggplant", "butternut", "butter beans", "peanut butter", "cocoa butter", "cream of coconut",
            "egg-free", "no egg", "vegan irish cream", "cashew cream", "oat cream", "soy cream", "dairy-free yogurt", "dairy-free", "nutritional yeast", "mushroom", "creamy", "honeydew", "agave",
            "cheesecloth", "crème de", "creme de", "kombu dashi", "mushroom dashi", "butterfly pea", "buttery", "fish-free", "fishless",
            "chicken-style", "vegetable", "jackfruit", "tofu", "seitan", "tempeh", "vegetarian parmesan-style", "vegetarian pecorino-style",
            "vegetarian cotija-style", "vegan mayonnaise", "vegan mayo", "dairy-free sour cream", "vegan feta-style cheese", "vegan feta"]


def fail(stem, msg):
    problems.append(f"{stem}: {msg}")


pending = set()
for path in sorted(SRC.glob("*.txt")) + sorted(PENDING.glob("*.txt")):
    waiting = path.parent == PENDING
    current = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        tag, rest = line[0], line[1:].strip()
        if line.startswith("@@"):
            if current is None:
                problems.append(f"{path.name}: version outside a recipe: {line[:60]}")
                continue
            base = current if not current.get("variant_of") else recipes[current["variant_of"]]
            body = line[2:].strip()
            if "=" in body and "|" not in body:
                diet, _, word = (x.strip() for x in body.partition("="))
                if diet not in DIET_NAMES or word not in ("same", "vegetarian"):
                    fail(base["stem"], f"bad version line {line}")
                    continue
                # "same": the regular recipe already fits; "vegetarian" (for vegan): copy the vegetarian version.
                base.setdefault("variants", {})[diet] = word
                continue
            parts = [p.strip() for p in body.split("|")]
            if len(parts) != 6 or parts[0] not in DIET_NAMES:
                fail(base["stem"], f"bad version header {line[:60]}")
                continue
            diet, title, prep, cook, allergens, desc = parts
            v = {"variant_of": base["stem"], "stem": f'{base["stem"]}~{diet}', "title": title, "description": desc,
                 "prep_minutes": int(prep), "cook_minutes": int(cook), "swaps": [], "parts": set(),
                 "allergens": [a.strip() for a in allergens.split(",") if a.strip() and a.strip() != "-"],
                 "ingredients": [], "steps": [], "tips": [], "variations": [], "make_ahead": "", "cocktail": None, "note": None}
            base.setdefault("variants", {})[diet] = v
            current = v
            continue
        if tag == "~" and current is not None and current.get("variant_of"):
            old, sep, new = rest.partition("=>")
            if not sep:
                fail(current["stem"], f"bad swap {rest}")
            else:
                current["swaps"].append((old.strip(), new.strip()))
            continue
        if current is not None and current.get("variant_of") and tag in "-#GTSV!":
            current["parts"].add(tag)
        if tag == "@":
            if current is not None and current.get("variant_of"):
                current = None
            parts = [p.strip() for p in rest.split("|")]
            if len(parts) != 7:
                problems.append(f"{path.name}: bad header {line[:60]}")
                current = None
                continue
            stem, title, serv, prep, cook, allergens, desc = parts
            current = {"stem": stem, "title": title, "description": desc, "servings": int(serv), "prep_minutes": int(prep),
                       "cook_minutes": int(cook), "ingredients": [], "steps": [],
                       "allergens": [a.strip() for a in allergens.split(",") if a.strip() and a.strip() != "-"],
                       "cocktail": None, "note": None, "tips": [], "make_ahead": "", "variations": []}
            if stem in recipes:
                fail(stem, "written twice")
            recipes[stem] = current
            if waiting:
                pending.add(stem)
        elif current is None:
            problems.append(f"{path.name}: line outside a recipe: {line[:60]}")
        elif tag == "-":
            parts = [p.strip() for p in rest.split("|")]
            if len(parts) != 3:
                fail(current["stem"], f"bad ingredient {rest}")
                continue
            current["ingredients"].append({"amount": parts[0], "unit": parts[1], "item": parts[2]})
        elif tag == "#":
            current["steps"].append(rest)
        elif tag == "G":
            parts = [p.strip() for p in rest.split("|")]
            if len(parts) != 4 or parts[2] not in ("y", "n"):
                fail(current["stem"], f"bad cocktail line {rest}")
                continue
            current["cocktail"] = {"glass": parts[0], "garnish": "" if parts[1] == "-" else parts[1], "alcoholic": parts[2] == "y",
                                   "non_alcoholic_version": None if parts[3] == "-" else parts[3]}
        elif tag == "!":
            current["note"] = rest
        elif tag == "T":
            current["tips"].append(rest)
        elif tag == "S":
            current["make_ahead"] = rest
        elif tag == "V":
            current["variations"].append(rest)
        else:
            problems.append(f"{path.name}: unknown line {line[:60]}")

import re

FIELDS = ("title", "description", "servings", "prep_minutes", "cook_minutes", "ingredients", "steps")


def check(stem, r, kind):
    """The app's rules for one recipe or version; returns the recipe as the app reads it."""
    if kind == "cocktail" and r["cocktail"] is None:
        fail(stem, "cocktail without a G line")
    if kind == "meal" and r["cocktail"] is not None:
        fail(stem, "meal with a G line")
    bad = set(r["allergens"]) - ALLERGENS
    if bad:
        fail(stem, f"unknown allergens {bad}")
    if not (1 <= len(r["ingredients"]) <= 40) or not (1 <= len(r["steps"]) <= 30):
        fail(stem, "needs 1-40 ingredients and 1-30 steps")
    if not (1 <= r["servings"] <= 100) or r["prep_minutes"] > 2880 or r["cook_minutes"] > 2880:
        fail(stem, "servings or minutes out of range")
    if len(r["title"]) > 120 or len(r["description"]) > 600 or any(len(x) > 600 for x in r["steps"]):
        fail(stem, "text too long")
    for i in r["ingredients"]:
        if len(i["amount"]) > 40 or len(i["unit"]) > 40 or len(i["item"]) > 200 or not i["item"]:
            fail(stem, f"bad ingredient {i}")
    if len(r["tips"]) > 8 or len(r["variations"]) > 6 or len(r["make_ahead"]) > 600:
        fail(stem, "up to 8 tips, 6 variations and 600 characters of make-ahead")
    if any(len(t) > 300 for t in r["tips"] + r["variations"]):
        fail(stem, "tips and variations must be 300 characters or less")
    return {k: r[k] for k in FIELDS} | {"allergens": sorted(set(r["allergens"])), "cocktail": r["cocktail"],
                                        "note": r["note"] or NOTES[kind], "tips": r["tips"], "make_ahead": r["make_ahead"],
                                        "variations": r["variations"]}


def swap(text, swaps):
    for old, new in sorted(swaps, key=lambda x: -len(x[0])):  # longer phrases first: "the egg white" before "egg white"
        text = text.replace(old, new)
    return text


def make_version(base, v):
    """The regular recipe with the version's swaps applied and its own parts put in."""
    sw = v["swaps"]
    out = {"title": v["title"], "description": v["description"], "servings": base["servings"], "prep_minutes": v["prep_minutes"],
           "cook_minutes": v["cook_minutes"], "allergens": v["allergens"]}
    out["ingredients"] = v["ingredients"] if "-" in v["parts"] else [
        {"amount": i["amount"], "unit": i["unit"], "item": swap(i["item"], sw)} for i in base["ingredients"]]
    out["steps"] = v["steps"] if "#" in v["parts"] else [swap(x, sw) for x in base["steps"]]
    out["tips"] = v["tips"] if "T" in v["parts"] else [swap(x, sw) for x in base["tips"]]
    out["variations"] = v["variations"] if "V" in v["parts"] else []
    out["make_ahead"] = v["make_ahead"] if "S" in v["parts"] else swap(base["make_ahead"], sw)
    out["note"] = v["note"] if "!" in v["parts"] else (swap(base["note"], sw) if base["note"] else None)
    c = v["cocktail"] if "G" in v["parts"] else base["cocktail"]
    out["cocktail"] = None if c is None else c | {"garnish": swap(c["garnish"], sw)}
    for old, _ in sw:
        where = [i["item"] for i in base["ingredients"]] + base["steps"] + base["tips"] + [base["make_ahead"] or "", base["note"] or ""]
        if base["cocktail"]:
            where.append(base["cocktail"]["garnish"])
        if not any(old in t for t in where):
            fail(v["stem"], f"swap text not found in the regular recipe: {old!r}")
    return out


def diet_problems(r, diet):
    banned = NOT_VEGAN if diet == "vegan" else NOT_VEGETARIAN
    text = " ".join([i["item"] for i in r["ingredients"]] + r["steps"] + [r["cocktail"]["garnish"] if r["cocktail"] else ""]).lower()
    for ok in sorted(PLANT_OK, key=len, reverse=True):
        text = text.replace(ok, " ")
    return [w for w in banned if re.search(r"\b" + re.escape(w), text)]


def inherited_problems(base, made, v, diet):
    """Tips, make-ahead and notes a version copies word for word from the regular recipe must not still talk about meat or
    dairy. Lines the version rewrote with a ~ swap were written for it on purpose, so comparisons like "flakes like fish" pass."""
    kept = set(base["tips"]) | {base["make_ahead"] or "", base["note"] or ""}
    copied = ([] if "T" in v["parts"] else made["tips"]) + ([] if "S" in v["parts"] else [made["make_ahead"] or ""]) \
        + ([] if "!" in v["parts"] else [made["note"] or ""])
    return diet_problems({"ingredients": [], "steps": [x for x in copied if x and x in kept], "cocktail": None}, diet)


out = {}
for stem, r in recipes.items():
    if r.get("variant_of"):
        continue
    kind = kinds.get(stem)
    if not kind and stem in pending:
        kind = "cocktail" if r["cocktail"] else "meal"
    if not kind:
        fail(stem, "no photo with this file name (put recipes still waiting for a photo in data/recipes/pending/)")
        continue
    entry = {"kind": kind, "recipe": check(stem, r, kind)}
    variants = r.get("variants")
    if variants:
        if set(variants) != set(DIET_NAMES):
            fail(stem, "needs both a vegetarian and a vegan version")
        entry["variants"] = {}
        for diet in DIET_NAMES:
            v = variants.get(diet)
            if v is None:
                continue
            if v == "vegetarian":
                veg = variants.get("vegetarian")
                if not isinstance(veg, dict):
                    fail(f"{stem}~{diet}", "'= vegetarian' needs a written vegetarian version")
                    continue
                v = dict(veg, title=veg["title"].replace("Vegetarian", "Vegan"),
                         description=veg["description"].replace("vegetarian", "vegan").replace("Vegetarian", "Vegan"), stem=f"{stem}~vegan")
            made = r if v == "same" else make_version(r, v)
            left = diet_problems(made, diet)
            if left:
                fail(f"{stem}~{diet}", f"still has {', '.join(left)}" + (" (marked same)" if v == "same" else ""))
            copied = [] if v == "same" else inherited_problems(r, made, v, diet)
            if copied:
                fail(f"{stem}~{diet}", f"a tip, note or make-ahead line copied from the regular recipe still names {', '.join(copied)};"
                                       " swap it with a ~ line or give the version its own T, S or ! lines")
            entry["variants"][diet] = "same" if v == "same" else check(f"{stem}~{diet}", made, kind)
    out[stem] = entry

missing = sorted(set(kinds) - set(out))
if problems:
    print("\n".join(problems))
    sys.exit(1)
OUT.write_text(json.dumps(dict(sorted(out.items())), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
waiting = sorted(s for s in pending if s not in kinds)
print(f"{len(out)} recipes written ({sum(1 for e in out.values() if e.get('variants'))} with vegetarian and vegan versions); {len(missing)} photos still without a recipe; {len(waiting)} recipes waiting for a photo")
if "--list-missing" in sys.argv:
    print(" ".join(missing))
