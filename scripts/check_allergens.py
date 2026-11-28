"""Flags recipes whose ingredients suggest an allergen the recipe doesn't list. Run after build_recipes.py."""
import json
import re
import sys
import hashlib
from datetime import date
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
RULES = {
    "milk": r"\b(butter|milk|cream(?! of coconut)|cheese|cheddar|mozzarella|parmesan|pecorino|ricotta|feta|paneer|yogurt|ghee|crema|queso|gruy|provolone|swiss|kibbeh|irish cream|sour cream|buttermilk|half-and-half|mascarpone)\b",
    "eggs": r"\b(eggs?|egg yolks?|yolks?|mayonnaise|mayo|egg noodles|eggnog|brioche|challah|coleslaw)\b",
    "wheat": r"\b(flour|bread|breadcrumbs|panko|pasta|spaghetti|fettuccine|linguine|macaroni|ziti|lasagna|noodles|tortillas?\b(?!.*corn)|pita|pide|baguette|rolls?|buns?|croutons|crackers|couscous|bulgur|soy sauce|beer|stout|lager|wrappers|pastry|pie crusts?|waffle|naan|roti|paratha|pav|dough|gingersnap|muffins|saltine|udon|ramen|vermicelli(?!.*rice)|kecap manis|kecap asin)\b",
    "soy": r"\b(soy|soya|soybeans?|soymilk|tofu|edamame|miso|kecap|tamari|tempeh|shoyu|hoisin|maggi)\b",
    "fish": r"\b(fish|anchov|cod|salmon|haddock|tuna|bonito|dashi|worcestershire|eel|unagi|saltfish)\b",
    "shellfish": r"\b(shrimp|prawn|crab|clam|mussel|lobster|scallop|oyster sauce|squid|octopus|crayfish|bagoong|shrimp paste|clamato)\b",
    "peanuts": r"\b(peanut)",
    "tree nuts": r"\b(almonds?|walnuts?|pecans?|cashews?|pistachios?|pine nuts|hazelnuts?|macadamias?|brazil nuts?|orgeat|amaretto|noyaux|frangelico|nutella|praline|marzipan)\b",
    "sesame": r"\b(sesame|tahini)\b",
}
SAFE_WORDS = {
    "milk": r"\b(?:(?:coconut|oat|soy|almond|cashew|rice) (?:milk|cream|yogurt)|(?:peanut|almond|cashew|cocoa) butter|butter lettuce|cream sherry)\b",
    "wheat": r"\b(?:corn tortillas?|taco shells|tortilla (?:chips|strips)|(?:thin |flat )?rice (?:vermicelli|noodles|flour)|chickpea flour|ginger beer|root beer)\b",
    "fish": r"\b(?:kombu|mushroom) dashi\b",
}
# Store-bought items whose allergens depend on the brand: list the allergen, name a checked brand with the diet word in
# front ("gluten-free ..."), or add a tip or note that tells the cook to check the label.
BRAND_DEPENDENT = {
    "wheat": r"\b(enchilada sauce|sambar powder|pav bhaji masala|asafoetida|hing)\b",
    "fish": r"\b(barbecue sauce|bbq sauce)\b",
}

QUALIFIERS = {
    "milk": r"(?:vegan|dairy-free|non-dairy|plant-based)",
    "eggs": r"(?:vegan|egg-free|plant-based)",
    "wheat": r"(?:gluten-free|wheat-free)",
    "tree nuts": r"nut-free",
    "fish": r"(?:vegan|vegetarian|fish-free|plant-based)",
}

def allergen_text(text, allergen):
    """Remove explicit substitutes for this allergen only; never mask a following 'and' ingredient."""
    text = text.lower()
    qualifier = QUALIFIERS.get(allergen)
    if qualifier:
        text = re.sub(r"\b" + qualifier + r"(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}", " ", text)
    return re.sub(SAFE_WORDS.get(allergen, r"(?!)"), " ", text)

def find_findings(recipes):
    """Keyword-based review suggestions; a flag is not proof of an allergen."""
    flags = []
    for stem, entry in sorted(recipes.items()):
        versions = [("standard", entry["recipe"])]
        versions += [(name, recipe) for name, recipe in entry.get("variants", {}).items() if isinstance(recipe, dict)]
        for name, recipe in versions:
            lines = [i["item"] + " " + i["unit"] for i in recipe["ingredients"]]
            if isinstance(recipe.get("cocktail"), dict) and recipe["cocktail"].get("garnish"):
                lines.append(recipe["cocktail"]["garnish"])
            for allergen, pattern in RULES.items():
                match = re.search(pattern, " ; ".join(allergen_text(line, allergen) for line in lines))
                if allergen not in recipe["allergens"] and match:
                    fingerprint = hashlib.sha256(json.dumps([stem, name, allergen, lines], ensure_ascii=False).encode()).hexdigest()
                    flags.append({"id": fingerprint, "recipe": stem, "version": name, "allergen": allergen,
                                  "message": f"{stem} ({name}): missing {allergen}? ({match.group(0)})"})
            advice = " ".join(recipe.get("tips") or []) + " " + (recipe.get("note") or "")
            for allergen, pattern in BRAND_DEPENDENT.items():
                match = re.search(pattern, " ; ".join(allergen_text(line, allergen) for line in lines))
                if allergen in recipe["allergens"] or not match or re.search(r"\blabel\b", advice, re.I):
                    continue
                fingerprint = hashlib.sha256(json.dumps([stem, name, allergen, "brand", lines], ensure_ascii=False).encode()).hexdigest()
                flags.append({"id": fingerprint, "recipe": stem, "version": name, "allergen": allergen,
                              "message": f"{stem} ({name}): {match.group(0)} may contain {allergen} depending on the brand;"
                                         " list it, name a checked brand, or add a label-check tip"})
    return flags

def find_flags(recipes):
    return [finding["message"] for finding in find_findings(recipes)]

def unreviewed_findings(findings, exceptions, today=None):
    today = today or date.today()
    if not isinstance(exceptions, list):
        raise ValueError("Allergen exceptions must be a list of individually reviewed findings.")
    reviewed = set()
    for item in exceptions:
        if not all(isinstance(item.get(key), str) and item[key].strip() for key in ("id", "reason", "reviewed_by", "expires")):
            raise ValueError("Every exception needs an id, reason, reviewer and expiry.")
        if item["id"] in reviewed:
            raise ValueError("Duplicate allergen exception.")
        if date.fromisoformat(item["expires"]) >= today:
            reviewed.add(item["id"])
    return [finding for finding in findings if finding["id"] not in reviewed]

def main():
    recipes = json.loads((ROOT / "data/recipes/recipes.json").read_text(encoding="utf-8"))
    findings = find_findings(recipes)
    exception_file = ROOT / "data/recipes/allergen-review.json"
    exceptions = json.loads(exception_file.read_text(encoding="utf-8")) if exception_file.exists() else []
    outstanding = unreviewed_findings(findings, exceptions)
    print("# Possible allergen issues for human review\n")
    print("Keyword matches may be false positives and cannot establish allergy safety. Check ingredients and product labels.\n")
    print(f"{len(findings)} possible issues; {len(outstanding)} require review.\n")
    for finding in findings:
        state = "UNREVIEWED" if finding in outstanding else "Reviewed exception"
        print(f"- **{state}**: {finding['message']} (`{finding['id']}`)")
    return 1 if outstanding else 0


if __name__ == "__main__":
    sys.exit(main())
