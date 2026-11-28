"""Checks the bundled recipes for food-safety advice and cooking times. Run after build_recipes.py.

    python3 scripts/check_recipe_quality.py            fails when a recipe breaks a rule below
    python3 scripts/check_recipe_quality.py --similar  also lists pairs of recipes that look alike, for a person to review

Rules (USDA safe minimum temperatures and FDA egg and seafood advice):
- A drink or dish that serves eggs raw or lightly cooked says pasteurized eggs are an option.
- A dish of raw fish says to buy fish that was frozen for raw eating.
- Raw poultry reaches 165°F and ground meat 160°F (165°F for ground poultry), unless it simmers, braises, bakes, roasts,
  steams or slow-cooks for at least 30 minutes in one step.
- No single step takes longer than the recipe's cook time allows (waiting steps such as marinating don't count).
"""
import json
import re
import sys
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_EGG = r"\b(egg whites?|egg yolks?|yolks?|whole egg|eggs?)\b"
LIGHTLY_COOKED = r"\b(raw egg|raw yolk|softly set|barely set|runny yolks?|yolks stay runny|center runny|poco hecha|lightly cooked|" \
                 r"only by the heat|poach the eggs|not scrambled|sunny side|over easy|to your liking|drop an egg yolk|" \
                 r"whisk in the yolk|blend the yolks|crack in the egg)\b"
RAW_FISH = r"\b(sushi-grade|sashimi-grade|sashimi|ceviche|crudo|tartare|poke)\b"
POULTRY = r"\b(chicken|turkey|duck|cornish hens?|hen|quail)\b"
NOT_RAW = r"\b(cooked|broth|stock|bouillon|rotisserie|sliced turkey|deli|smoked|-style)\b"
GROUND = r"\b(ground|minced)\s+(beef|pork|lamb|veal|goat|meat|chicken|turkey|chuck)\b|\bground (pork|beef|lamb) and (pork|beef|lamb)\b"
POULTRY_STEP = r"\b(chicken|turkey|duck|hens?|quail|thighs?|breasts?|drumsticks?|wings?|legs?|meat|bird)\b"
MEAT_STEP = r"\b(beef|pork|lamb|veal|goat|turkey|chicken|meat|meats|chuck|meatballs?|patties|filling|kofta|kibbeh)\b"
LONG_COOK = r"\b(simmer|braise|bake|roast|stew|steam|slow cooker|cook on low|smoke)\w*"
WAITING = r"\b(marinat\w*|soak\w*|chill\w*|refrigerat\w*|rest(?:s|ing)?\b(?! of)|stand\w*|cool\w*|overnight|rise|rising|" \
          r"proof\w*|freez\w*|sit|sits|sitting|steep\w*|room temperature|heat the oven|preheat\w*|heat a smoker|drain\w*|" \
          r"thaw\w*|brine|brining|cure|curing|set aside|let it|let them)"
COOKING = r"\b(bake|roast|simmer|cook|boil|fry|grill|broil|steam|braise|smoke|toast|sear|brown|poach|stew|stir-fry|blend|" \
          r"shake|stir|whisk|heat|warm|reduce)\w*"
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4}


def versions(recipes):
    """Every bundled recipe and every written diet version, as (name, kind, recipe)."""
    for stem, entry in sorted(recipes.items()):
        yield stem, entry["kind"], entry["recipe"]
        for diet, recipe in (entry.get("variants") or {}).items():
            if isinstance(recipe, dict):
                yield f"{stem}~{diet}", entry["kind"], recipe


def timed(text):
    """Every duration in a sentence as (minutes, start, end), taking the top of a range ("15 to 20 minutes" -> 20)."""
    found = []
    # "1 hour 10 minutes" is one duration of 70 minutes, not 60 and 10.
    text = re.sub(r"\b(\d+) hours? (?:and )?(\d+) minutes?\b", lambda m: f"{int(m.group(1)) * 60 + int(m.group(2))} minutes", text)
    pattern = r"(\d+(?: \d/\d)?|\d/\d|one|two|three|four)(?:\s*(?:to|-|–)\s*(\d+(?: \d/\d)?))?\s*(hours?|hrs?|minutes?|mins?)\b"
    for m in re.finditer(pattern, text, re.I):
        raw = (m.group(2) or m.group(1)).lower()
        if raw in WORDS:
            value = WORDS[raw]
        else:
            whole, _, frac = raw.partition(" ")
            if "/" in whole:
                frac, whole = whole, "0"
            value = int(whole) + (int(frac.split("/")[0]) / int(frac.split("/")[1]) if frac else 0)
        found.append((value * 60 if m.group(3).lower().startswith("h") else value, m.start(), m.end(), text))
    return found


def minutes(text):
    return [value for value, *_ in timed(text)]


def sentences(steps):
    for step in steps:
        yield from (part for part in re.split(r"(?<=[.;])\s+", step) if part)


def long_cook(steps, meat):
    """True when a step that comes at or after the first step naming the meat simmers, bakes or braises for 30 minutes or
    more. A side dish that bakes for an hour before the meat goes in (stuffed sweet potatoes) doesn't count."""
    first = next((i for i, step in enumerate(steps) if re.search(meat, step, re.I)), None)
    if first is None:
        return False
    return any(re.search(LONG_COOK, s, re.I) and max(minutes(s) or [0]) >= 30 for s in sentences(steps[first:]))


def reaches(steps, lowest):
    """True when a step names a temperature of at least `lowest` °F."""
    return any(int(t) >= lowest for t in re.findall(r"\b(\d{3}) ?°? ?F\b", steps) if int(t) < 212)


def eggs_reach_160(steps):
    """True when a step at or after the first one that adds the eggs reaches 160°F. A temperature for meat cooked before
    the eggs go in (oyakodon's chicken, say) says nothing about the eggs."""
    egg_steps = [i for i, s in enumerate(steps) if re.search(r"\b(eggs?|yolks?|whites?)\b", s, re.I)]
    return any(reaches(s, 160) for s in steps[egg_steps[0] if egg_steps else 0:])


def safety_problems(name, kind, r):
    problems = []
    items = [i["item"] for i in r["ingredients"]]
    advice = " ".join(r.get("tips") or []) + " " + (r.get("note") or "")
    every_text = " ".join(items + r["steps"] + [advice])
    has_egg = any(re.search(RAW_EGG, i, re.I) and not re.search(r"hard-boiled|boiled|eggplant|egg noodles|egg-free", i, re.I)
                  for i in items)
    cooked_base = eggs_reach_160(r["steps"])  # eggnog, custards and set shakshuka heat the eggs to 160°F
    raw_in_drink = kind == "cocktail" and has_egg and not cooked_base
    # A dish that is never cooked (tiramisu, mousse, a raw-yolk dressing) serves its eggs raw.
    never_cooked = has_egg and not cooked_base and r.get("cook_minutes", 0) == 0
    lightly_cooked = has_egg and not cooked_base and (never_cooked or re.search(LIGHTLY_COOKED, every_text, re.I))
    if (raw_in_drink or lightly_cooked) and not re.search(r"pasteuri[sz]ed", advice, re.I):
        problems.append(f"{name}: serves eggs raw or lightly cooked; add a tip or note that pasteurized eggs are an option")
    drink = r.get("cocktail") or {}
    na = drink.get("non_alcoholic_version") or ""
    if re.search(r"\begg white\b", na, re.I) and not re.search(r"pasteuri[sz]ed|aquafaba", na, re.I):
        problems.append(f"{name}: the alcohol-free version uses raw egg white; offer pasteurized egg white or aquafaba")
    if kind == "meal" and re.search(RAW_FISH, " ".join(items + [r["title"], r["description"]]), re.I) \
            and not re.search(r"\bfrozen\b", advice, re.I):
        problems.append(f"{name}: serves fish raw; say to buy fish frozen for raw eating, and who should avoid it")
    steps = " ".join(r["steps"])
    raw_poultry = any(re.search(POULTRY, i, re.I) and not re.search(NOT_RAW, i, re.I) for i in items)
    if raw_poultry and not reaches(steps, 165) and not long_cook(r["steps"], POULTRY_STEP):
        problems.append(f"{name}: cooks raw poultry briefly; say it reaches 165°F")
    ground = any(re.search(GROUND, i, re.I) for i in items)
    if ground and not reaches(steps, 160) and not long_cook(r["steps"], MEAT_STEP):
        problems.append(f"{name}: cooks ground meat briefly; say it reaches 160°F (165°F for poultry)")
    return problems


def active_minutes(sentence):
    """Durations of cooking, not waiting. Each duration is judged by the words since the previous one, so "Bake for 30
    minutes and cool completely" counts 30, while "Marinate ... for 1 hour" and "sit 30 minutes, or up to 2 hours" don't."""
    out, waiting, last = [], False, 0
    for value, start, end, text in timed(sentence):
        context = text[last:end]
        if re.search(WAITING, context, re.I):
            waiting = True
        elif re.search(COOKING, context, re.I):
            waiting = False
        if not waiting:
            out.append(value)
        last = end
    return out


def time_problems(name, r):
    longest = max([max(active_minutes(s) or [0]) for s in sentences(r["steps"])] or [0])
    allowed = r["cook_minutes"] * 1.1 + 5
    if longest > allowed:
        return [f"{name}: a step takes {longest:g} minutes but the cook time is {r['cook_minutes']} minutes"]
    return []


def find_problems(recipes):
    found = []
    for name, kind, r in versions(recipes):
        found += safety_problems(name, kind, r) + time_problems(name, r)
    return found


def ingredient_words(r):
    words = set()
    for i in r["ingredients"]:
        item = re.sub(r"\(.*?\)|,.*$", "", i["item"].lower())
        words.add(re.sub(r"\b(fresh|chilled|vegan|large|small|to serve|to garnish)\b", "", item).strip())
    return {w for w in words if w}


def similar_pairs(recipes, threshold=0.75):
    """Recipes of the same kind whose ingredient lists mostly overlap: candidates for a person to compare, not errors."""
    rows = [(stem, e["kind"], ingredient_words(e["recipe"])) for stem, e in sorted(recipes.items())]
    pairs = []
    for (a, ka, wa), (b, kb, wb) in combinations(rows, 2):
        if ka == kb and wa and wb:
            score = len(wa & wb) / len(wa | wb)
            if score >= threshold:
                pairs.append((round(score, 2), a, b))
    return sorted(pairs, reverse=True)


def main():
    recipes = json.loads((ROOT / "data/recipes/recipes.json").read_text(encoding="utf-8"))
    problems = find_problems(recipes)
    for p in problems:
        print(p)
    if "--similar" in sys.argv:
        print("\nRecipes that look alike (review by hand; many are real variations):")
        for score, a, b in similar_pairs(recipes):
            print(f"  {score:.2f}  {a}  ~  {b}")
    print(f"{len(problems)} recipe quality problems.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
