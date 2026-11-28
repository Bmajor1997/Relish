"""Tests for the automated recipe consistency and allergen review checks."""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("check_allergens", ROOT / "scripts/check_allergens.py")
allergens = importlib.util.module_from_spec(spec)
spec.loader.exec_module(allergens)


def load_script(name):
    module_spec = importlib.util.spec_from_file_location(name, ROOT / f"scripts/{name}.py")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


quality = load_script("check_recipe_quality")
duplicates = load_script("check_photo_duplicates")


def make_recipe(**parts):
    recipe = {"title": "Test", "description": "", "cook_minutes": 30, "ingredients": [], "steps": [], "tips": [],
              "note": None, "cocktail": None, "allergens": []}
    recipe.update(parts)
    return recipe


class AllergenReviewTests(unittest.TestCase):
    def test_explicit_substitutes_do_not_hide_separate_allergens(self):
        recipe = {"ingredients": [{"item": "vegan butter and milk", "unit": ""}, {"item": "coconut milk", "unit": ""}], "allergens": []}
        flags = allergens.find_flags({"soup": {"recipe": recipe}})
        self.assertEqual(len(flags), 1)
        self.assertIn("missing milk", flags[0])
        recipe["ingredients"] = [{"item": "coconut milk and peanut butter", "unit": ""}]
        flags = allergens.find_flags({"soup": {"recipe": recipe}})
        self.assertFalse(any("missing milk" in flag for flag in flags))
        self.assertTrue(any("missing peanuts" in flag for flag in flags))

    def test_garnishes_are_checked(self):
        recipe = {"ingredients": [], "allergens": [], "cocktail": {"garnish": "sesame seeds"}}
        self.assertIn("missing sesame", allergens.find_flags({"drink": {"recipe": recipe}})[0])

    def test_review_is_scoped_to_exact_ingredients_and_expires(self):
        recipes = {"soup": {"recipe": {"ingredients": [{"item": "butter", "unit": "tbsp"}], "allergens": []}}}
        findings = allergens.find_findings(recipes)
        exception = {"id": findings[0]["id"], "reason": "Reviewed example", "reviewed_by": "test reviewer", "expires": "2026-12-01"}
        self.assertEqual(allergens.unreviewed_findings(findings, [exception], date(2026, 11, 22)), [])
        self.assertEqual(allergens.unreviewed_findings(findings, [exception], date(2026, 12, 2)), findings)
        recipes["soup"]["recipe"]["ingredients"][0]["item"] = "butter and cream"
        changed = allergens.find_findings(recipes)
        self.assertEqual(allergens.unreviewed_findings(changed, [exception], date(2026, 11, 22)), changed)
        with self.assertRaises(ValueError):
            allergens.unreviewed_findings(findings, [{"id": exception["id"]}])

    def test_reports_missing_allergens_in_original_and_diet_version(self):
        recipes = {"soup": {"recipe": {"ingredients": [{"item": "butter", "unit": "tbsp"}], "allergens": []},
                           "variants": {"vegan": {"ingredients": [{"item": "cashews", "unit": "cup"}], "allergens": []},
                                        "vegetarian": "same"}}}
        flags = allergens.find_flags(recipes)
        self.assertTrue(any("soup (standard): missing milk" in f for f in flags))
        self.assertTrue(any("soup (vegan): missing tree nuts" in f for f in flags))

    def test_kecap_manis_needs_wheat(self):
        recipe = {"ingredients": [{"item": "kecap manis (sweet soy sauce)", "unit": "tbsp"}], "allergens": ["soy"]}
        self.assertTrue(any("missing wheat" in f for f in allergens.find_flags({"salad": {"recipe": recipe}})))

    def test_brand_dependent_items_need_a_label_tip_or_the_allergen(self):
        recipe = {"ingredients": [{"item": "red enchilada sauce", "unit": "cups"}], "allergens": ["milk"], "tips": []}
        flags = allergens.find_flags({"bake": {"recipe": recipe}})
        self.assertTrue(any("depending on the brand" in f for f in flags))
        recipe["tips"] = ["Check the enchilada sauce label if you avoid wheat."]
        self.assertEqual(allergens.find_flags({"bake": {"recipe": recipe}}), [])
        recipe["tips"], recipe["allergens"] = [], ["milk", "wheat"]
        self.assertEqual(allergens.find_flags({"bake": {"recipe": recipe}}), [])

    def test_does_not_report_an_allergen_already_listed(self):
        recipes = {"soup": {"recipe": {"ingredients": [{"item": "butter", "unit": "tbsp"}], "allergens": ["milk"]}}}
        self.assertEqual(allergens.find_flags(recipes), [])


class RecipeQualityTests(unittest.TestCase):
    def problems(self, recipe, kind="meal"):
        return quality.safety_problems("test", kind, recipe) + quality.time_problems("test", recipe)

    def test_raw_egg_drink_needs_pasteurized_advice(self):
        drink = make_recipe(ingredients=[{"item": "egg white", "unit": ""}], steps=["Dry-shake, then shake with ice."],
                            cocktail={"non_alcoholic_version": "-"})
        self.assertTrue(any("pasteurized" in p for p in self.problems(drink, "cocktail")))
        drink["tips"] = ["This drink uses raw egg white. Use pasteurized egg white if you prefer."]
        self.assertEqual(self.problems(drink, "cocktail"), [])
        cooked = make_recipe(ingredients=[{"item": "eggs", "unit": ""}], steps=["Heat the custard to 160°F."])
        self.assertEqual(self.problems(cooked, "cocktail"), [])

    def test_alcohol_free_version_with_raw_egg_white(self):
        drink = make_recipe(tips=["Use pasteurized egg white if you prefer."], ingredients=[{"item": "egg white", "unit": ""}],
                            cocktail={"non_alcoholic_version": "Shake lemon, syrup and egg white."})
        self.assertTrue(any("alcohol-free" in p for p in self.problems(drink, "cocktail")))

    def test_lightly_cooked_eggs_in_a_meal(self):
        meal = make_recipe(ingredients=[{"item": "large eggs", "unit": ""}], steps=["Cook 1 minute until softly set."])
        self.assertTrue(any("pasteurized" in p for p in self.problems(meal)))
        meat_first = make_recipe(ingredients=[{"item": "chicken thigh", "unit": "oz"}, {"item": "large eggs", "unit": ""}],
                                 steps=["Cook the chicken 5 minutes, until 165°F.", "Pour the eggs over and cook until softly set."])
        self.assertTrue(any("pasteurized" in p for p in self.problems(meat_first)))
        tiramisu = make_recipe(cook_minutes=0, ingredients=[{"item": "very fresh large eggs, separated", "unit": ""}],
                               steps=["Beat the yolks with sugar.", "Whip the whites and fold them in."])
        self.assertTrue(any("pasteurized" in p for p in self.problems(tiramisu)))
        sunny = make_recipe(ingredients=[{"item": "large eggs", "unit": ""}], steps=["Fry the eggs sunny side up."])
        self.assertTrue(any("pasteurized" in p for p in self.problems(sunny)))
        set_eggs = make_recipe(ingredients=[{"item": "eggs", "unit": ""}], tips=["Don't assume runny yolks suit everyone."],
                               steps=["Cook until the eggs reach 160 F (71 C)."])
        self.assertEqual(self.problems(set_eggs), [])

    def test_raw_fish_needs_freezing_advice(self):
        meal = make_recipe(title="Ceviche", ingredients=[{"item": "white fish", "unit": "lb"}], steps=["Cure in lime."])
        self.assertTrue(any("frozen" in p for p in self.problems(meal)))
        meal["note"] = "Buy fish frozen for raw eating."
        self.assertEqual(self.problems(meal), [])

    def test_briefly_cooked_poultry_and_ground_meat_need_temperatures(self):
        meal = make_recipe(cook_minutes=15, ingredients=[{"item": "boneless chicken thighs", "unit": "lb"}],
                           steps=["Grill 5 minutes per side until cooked."])
        self.assertTrue(any("165°F" in p for p in self.problems(meal)))
        meal["steps"] = ["Grill 5 minutes per side until cooked through (165°F)."]
        self.assertEqual(self.problems(meal), [])
        braise = make_recipe(cook_minutes=60, ingredients=[{"item": "ground beef", "unit": "lb"}],
                             steps=["Brown the beef.", "Simmer, covered, for 45 minutes."])
        self.assertEqual(self.problems(braise), [])
        burger = make_recipe(cook_minutes=10, ingredients=[{"item": "ground chuck", "unit": "lb"}], steps=["Cook 4 minutes a side."])
        self.assertTrue(any("160°F" in p for p in self.problems(burger)))
        plain = make_recipe(cook_minutes=15, ingredients=[{"item": "ground turkey", "unit": "lb"}],
                            steps=["Heat oven to 425 F (220 C).", "Cook 6 minutes, until it reaches 165 F (74 C)."])
        self.assertEqual(self.problems(plain), [])
        side_first = make_recipe(cook_minutes=55, ingredients=[{"item": "ground turkey", "unit": "lb"}],
                                 steps=["Bake the sweet potatoes 45 to 55 minutes.", "Brown the turkey in a skillet."])
        self.assertTrue(any("160°F" in p for p in self.problems(side_first)))
        cooked = make_recipe(ingredients=[{"item": "shredded cooked chicken", "unit": "cups"}], steps=["Warm 5 minutes."])
        self.assertEqual(self.problems(cooked), [])

    def test_hours_and_minutes_are_one_duration(self):
        self.assertEqual(quality.minutes("Roast 1 hour 10 minutes to 1 hour 20 minutes."), [70, 80])
        meal = make_recipe(cook_minutes=60, steps=["Roast 1 hour 10 minutes to 1 hour 20 minutes, until 165°F."])
        self.assertTrue(any("cook time" in p for p in self.problems(meal)))

    def test_waiting_words_only_cover_their_own_time(self):
        self.assertEqual(quality.active_minutes("Bake for 30 to 35 minutes and cool completely."), [35])
        self.assertEqual(quality.active_minutes("Bake 50 minutes, add the rest of the glaze and bake 10 minutes more."), [50, 10])
        self.assertEqual(quality.active_minutes("Let it sit for at least 30 minutes, or up to 2 hours."), [])
        self.assertEqual(quality.active_minutes("Marinate the chicken in soy and 1/4 cup coconut milk for 1 hour."), [])
        cake = make_recipe(cook_minutes=10, steps=["Bake for 30 to 35 minutes and cool completely."])
        self.assertTrue(any("cook time" in p for p in self.problems(cake)))

    def test_step_longer_than_the_cook_time(self):
        meal = make_recipe(cook_minutes=75, steps=["Marinate overnight.", "Cover and bake at 350°F for 1 1/2 hours."])
        self.assertTrue(any("cook time" in p for p in self.problems(meal)))
        meal["cook_minutes"] = 105
        self.assertEqual(self.problems(meal), [])

    def test_similar_recipes_are_reported(self):
        a = make_recipe(ingredients=[{"item": i, "unit": ""} for i in ("gin", "lemon juice", "simple syrup", "soda water")])
        b = make_recipe(ingredients=[{"item": i, "unit": ""} for i in ("gin", "lemon juice", "simple syrup", "soda water")])
        pairs = quality.similar_pairs({"a": {"kind": "cocktail", "recipe": a}, "b": {"kind": "cocktail", "recipe": b}})
        self.assertEqual(pairs, [(1.0, "a", "b")])

    def test_removing_a_safety_tip_is_caught(self):
        recipes = json.loads((ROOT / "data/recipes/recipes.json").read_text(encoding="utf-8"))
        for stem in ("tiramisu", "japanese-oyakodon", "spaghetti-carbonara", "eggs-benedict", "clover-club"):
            recipe = json.loads(json.dumps(recipes[stem]["recipe"]))
            recipe["tips"] = [t for t in recipe["tips"] if "pasteurized" not in t]
            recipe["note"] = None
            self.assertTrue(quality.safety_problems(stem, recipes[stem]["kind"], recipe), stem)

    def test_current_data_passes(self):
        recipes = json.loads((ROOT / "data/recipes/recipes.json").read_text(encoding="utf-8"))
        self.assertEqual(quality.find_problems(recipes), [])


class PhotoDuplicateTests(unittest.TestCase):
    PRINTS = {"a.jpg": {"phash": "ffffffffffffffff"}, "b.jpg": {"phash": "fffffffffffffff0"}, "c.jpg": {"phash": "0000000000000000"}}

    def test_close_photos_need_review(self):
        pairs = duplicates.close_pairs(self.PRINTS)
        self.assertEqual(pairs, [("a.jpg", "b.jpg", 4)])
        review = [{"photos": ["b.jpg", "a.jpg"], "reason": "Different photos", "reviewed_by": "test", "expires": "2026-12-01"}]
        self.assertEqual(duplicates.unreviewed_pairs(pairs, review, date(2026, 11, 27)), [])
        self.assertEqual(duplicates.unreviewed_pairs(pairs, review, date(2026, 12, 2)), pairs)
        with self.assertRaises(ValueError):
            duplicates.unreviewed_pairs(pairs, [{"photos": ["a.jpg", "b.jpg"]}])

    def test_stale_fingerprints_are_found(self):
        with tempfile.TemporaryDirectory() as folder:
            photo = Path(folder) / "a.jpg"
            photo.write_bytes(b"photo")
            self.assertEqual(duplicates.stale_fingerprints({}, Path(folder)), ["a.jpg: no fingerprint"])
            prints = {"a.jpg": {"sha256": "0" * 64}, "gone.jpg": {"sha256": "0" * 64}}
            problems = duplicates.stale_fingerprints(prints, Path(folder))
            self.assertIn("a.jpg: photo changed since its fingerprint was made", problems)
            self.assertIn("gone.jpg: fingerprint for a photo that no longer exists", problems)

    def test_current_photos_pass(self):
        prints = json.loads(duplicates.PRINTS.read_text(encoding="utf-8"))
        self.assertEqual(duplicates.stale_fingerprints(prints), [])
        review = json.loads(duplicates.REVIEW.read_text(encoding="utf-8"))
        self.assertEqual(duplicates.unreviewed_pairs(duplicates.close_pairs(prints), review), [])


class RecipeConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for folder in ("scripts", "data/recipes", "data/curated-photos", "apps/mobile/src/recipes"):
            shutil.copytree(ROOT / folder, self.root / folder, dirs_exist_ok=True)

    def run_check(self):
        return subprocess.run([sys.executable, str(self.root / "scripts/check_recipe_consistency.py")],
                              capture_output=True, text=True)

    def test_current_data_agrees(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_modified_app_recipe_is_detected(self):
        path = self.root / "apps/mobile/src/recipes/collection.json"
        recipes = json.loads(path.read_text(encoding="utf-8"))
        recipes[next(iter(recipes))]["title"] = "A changed title"
        path.write_text(json.dumps(recipes), encoding="utf-8")
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collection.json", result.stderr)

    def test_changed_source_requires_regeneration(self):
        path = self.root / "data/recipes/src/cocktails-02.txt"
        source = path.read_text(encoding="utf-8")
        self.assertIn("Scotch and amaretto over ice.", source)
        path.write_text(source.replace("Scotch and amaretto over ice.", "A different description.", 1), encoding="utf-8")
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("godfather", result.stderr)

    def test_version_tip_copied_with_meat_is_rejected(self):
        path = self.root / "data/recipes/src/new-meals-01.txt"
        source = path.read_text(encoding="utf-8")
        swap = "~ Keep the chicken at a gentle simmer so it stays tender enough to shred. => "
        self.assertIn(swap, source)
        lines = [line for line in source.split("\n") if not line.startswith(swap)]
        path.write_text("\n".join(lines), encoding="utf-8")
        result = subprocess.run([sys.executable, str(self.root / "scripts/build_recipes.py")], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ajiaco~vegetarian", result.stdout + result.stderr)

    def test_modified_variant_is_detected(self):
        path = self.root / "apps/mobile/src/recipes/collectionVariants.json"
        versions = json.loads(path.read_text(encoding="utf-8"))
        versions.pop(next(iter(versions)))
        path.write_text(json.dumps(versions), encoding="utf-8")
        result = self.run_check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collectionVariants.json", result.stderr)


if __name__ == "__main__":
    unittest.main()
