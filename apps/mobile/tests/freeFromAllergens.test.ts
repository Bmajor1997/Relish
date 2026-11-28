// Saved and Recently viewed AI recipes read free-from words as the server does: "dairy-free cheese" isn't milk, but a
// free-from word never hides another allergen (2026-11-27 E2E regression test of main, finding F2).
import { expect, it } from "vitest";
import { with_ingredient_allergens } from "../src/recipes/allergenRisk";
import type { Recipe } from "../src/recipes/types";

const allergens = (item: string) =>
  with_ingredient_allergens({
    title: item,
    description: "",
    servings: 1,
    prep_minutes: 1,
    cook_minutes: 1,
    ingredients: [{ amount: "1", unit: "", item }],
    steps: ["Serve."],
    allergens: [],
    cocktail: null,
    note: "",
  } satisfies Recipe).allergens;

it.each(["dairy-free cheese", "milk-free chocolate", "egg-free mayonnaise", "nut-free pesto", "peanut-free satay sauce"])(
  "%s names no allergen",
  (item) => expect(allergens(item)).toEqual([]),
);

it.each([
  ["dairy-free egg noodles", ["eggs", "wheat"]],
  ["dairy-free almond milk", ["tree nuts"]],
  ["nut-free peanut butter", ["peanuts"]],
  ["dairy-free cheese and butter", ["milk"]],
  ["lactose-free milk", ["milk"]],
  ["vegan whole wheat bread", ["wheat"]],
])("%s still names %j", (item, expected) => expect(allergens(item)).toEqual(expected));
