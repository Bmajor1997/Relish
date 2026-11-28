// Allergens a recipe may contain but can't be confirmed from its words: shown as "May contain", never as a guarantee
// either way. The recipe's own allergen list stays the confirmed part (from its ingredients, checked twice for AI
// recipes); this adds what depends on the brand or on wording that disagrees with the ingredient list.
import { allergens_in } from "./curatedVersions";
import type { Recipe } from "./types";

// Made with or without nuts depending on the brand: falernum is often made with almond, amaretto with almond or
// apricot kernel, crème de noyaux with apricot or almond kernels, nougat and mole paste often hold nuts.
const BRAND_DEPENDENT: { allergen: string; words: RegExp }[] = [
  { allergen: "tree nuts", words: /\b(?:falernum|amaretto|noyaux|nougat|mole paste|nut liqueur)\b/i },
];
// The line names a formulation without them ("nut-free amaretto (such as Disaronno)"). "Almond-free" isn't enough:
// the drink may still use another nut.
const SAYS_FREE = /\b(?:nut-free|nut free|tree nut-free)\b/i;
// Words that describe a taste ("almond-scented"), not an ingredient.
const FLAVOR_WORDS = /\b[a-z]+-(?:flavou?red|scented|like|free)\b/gi;
// The allergens read from a description or method that disagrees with the ingredients: the nut allergens, where a
// mention matters most and a serving suggestion is rarely the reason.
const FROM_WORDING = new Set(["tree nuts", "peanuts"]);

type PossibleAllergen = { allergen: string; because: string[] };

/** What the recipe may contain beyond its listed allergens, each with the words that raise it. */
export function possible_allergens(recipe: Recipe): PossibleAllergen[] {
  const listed = new Set(recipe.allergens);
  const found = new Map<string, Set<string>>();
  const add = (allergen: string, because: string) => {
    if (listed.has(allergen)) return;
    if (!found.has(allergen)) found.set(allergen, new Set());
    found.get(allergen)!.add(because);
  };
  // An ingredient list when there is one; a drink written only as a method is read from its method.
  const lines = recipe.ingredients.length ? recipe.ingredients.map((i) => i.item) : recipe.steps;
  for (const line of [...lines, recipe.cocktail?.garnish ?? ""]) {
    if (SAYS_FREE.test(line)) continue;
    for (const { allergen, words } of BRAND_DEPENDENT) {
      const hit = line.match(words);
      if (hit) add(allergen, hit[0].toLowerCase());
    }
  }
  // Brand-dependent words were judged on the ingredient lines above ("nut-free amaretto" then "shake the amaretto").
  let wording = [recipe.description, ...recipe.steps].join(" ").replace(FLAVOR_WORDS, " ");
  for (const { words } of BRAND_DEPENDENT)
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    wording = wording.replace(new RegExp(words.source, "gi"), " ");
  for (const allergen of allergens_in(wording, [])) if (FROM_WORDING.has(allergen)) add(allergen, "the description or method");
  return [...found].map(([allergen, because]) => ({ allergen, because: [...because] }));
}

/** One line for the recipe screen and shared text, or "" when there's nothing to add. */
export function possible_allergen_line(recipe: Recipe): string {
  const possible = possible_allergens(recipe);
  if (!possible.length) return "";
  const parts = possible.map(({ allergen, because }) => `${allergen} (${because.join(", ")})`);
  return `May contain ${parts.join("; ")}: these depend on the brand or recipe, so check the label.`;
}

// The server's own allergen words and look-alikes (server/recipe_ai.js), copied exactly; a check in
// code_checks/server.test.js keeps the two in step. They know more plant foods than the cocktail-version lists in
// curatedVersions.ts ("coconut yogurt", "apple butter", "vegan almond milk"), so a kept recipe is read as the server
// reads a new one.
const ALLERGEN_ORDER = ["milk", "eggs", "fish", "shellfish", "tree nuts", "peanuts", "wheat", "soy", "sesame"];
const ALLERGEN_WORDS: Record<string, RegExp> = {
  milk: /\b(?:milk|butter|buttermilk|cream|cheeses?|parmesan|parmigiano|pecorino|mozzarella|cheddar|feta|ricotta|mascarpone|paneer|halloumi|gruy[eè]re|brie|gouda|yogh?urt|ghee|cr[eè]me fra[iî]che|sour cream|half-and-half|whey|condensed milk|evaporated milk|irish cream)\b/,
  eggs: /\b(?:eggs?|egg (?:yolks?|whites?)|eggnog|mayonnaise|mayo|aioli|meringue)\b/,
  fish: /\b(?:fish|salmon|tuna|cod|halibut|tilapia|trout|mackerel|sardines?|anchov(?:y|ies)|bonito|haddock|snapper|sea bass|catfish|worcestershire)\b/,
  shellfish: /\b(?:shrimp|prawns?|crab|lobster|crawfish|crayfish|scallops?|clams?|mussels?|oysters?|langoustines?)\b/,
  "tree nuts":
    /\b(?:almonds?|cashews?|walnuts?|pecans?|pistachios?|hazelnuts?|macadamias?|pine nuts?|brazil nuts?|orgeat|amaretto|frangelico|marzipan|praline|pesto|nutella)\b/,
  peanuts: /\b(?:peanuts?|peanut butter|satay)\b/,
  wheat:
    /\b(?:wheat(?!-free\b)|flour|bread|breadcrumbs|panko|pasta|spaghetti|penne|linguine|fettuccine|macaroni|lasagna|noodles?|couscous|bulgur|farro|semolina|tortillas?|pitas?|naan|baguette|croutons?|soy sauce|seitan|udon|ramen|dumpling wrappers?|wonton wrappers?|pie crust|puff pastry|phyllo|crackers?|beer|ale|lager|stout|malt|barley)\b/,
  soy: /\b(?:soy|soya|soybeans?|soymilk|tofu|edamame|miso|tempeh|soy sauce|tamari|shoyu)\b/,
  sesame: /\b(?:sesame|tahini|furikake|za'?atar)\b/,
};
const NOT_AN_ALLERGEN =
  /\b(?:coconut|oat|rice|almond|soy|cashew) (?:milk|cream|yogh?urt)\b|\bcream of (?:coconut|tartar)\b|\b(?:peanut|almond|cashew|sunflower|apple|cocoa|shea|nut|seed) butter\b|\bbutternut\b|\bbutter (?:beans|lettuce)\b|\beggplants?\b|\b(?:gluten-free|rice|glass|cellophane|soba|corn|sweet potato) (?:pasta|noodles|tortillas?|bread|flour|crackers?|panko)\b|\b(?:rice|corn|almond|coconut|chickpea|tapioca|potato|cassava) flour\b|\bcornbread\b|\bfish-free\b|\bwater chestnuts?\b|\bnutmeg\b|\bginger (?:beer|ale)\b|\broot beer\b|\bgluten-free (?:beer|ale|lager)\b|\bcream sherry\b/g;
// "Vegan" rules out dairy, eggs, fish and shellfish, not wheat; a free-from word ("dairy-free", "nut-free") only the
// allergen it names (as on the server).
const NOT_THIS_ALLERGEN: Record<string, RegExp> = {
  milk: /\b(?:vegan|(?:dairy|milk)-free)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  eggs: /\b(?:vegan|eggs?-free)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  fish: /\b(?:vegan|fish-free)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  shellfish: /\b(?:vegan|shellfish-free)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  "tree nuts": /\b(?:tree[ -])?nut-free(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  peanuts: /\bpeanut-free(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  soy: /\bsoya?-free(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  sesame: /\bsesame-free(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g,
  wheat: /\b(?:wheat|gluten)-free(?: (?!and\b|or\b|with\b)[a-z'-]+){1,3}|\bsingle malt\b|\bmalt whiske?y\b/g,
};
const CHECKED_ON_FULL_NAME = new Set(["tree nuts", "peanuts", "soy", "sesame"]);

/** The allergens one ingredient line names, read the way the server reads them. */
function named_in(line: string): string[] {
  const raw = line.toLowerCase();
  const plain = raw.replace(NOT_AN_ALLERGEN, " ");
  return Object.entries(ALLERGEN_WORDS)
    .filter(([allergen, words]) =>
      words.test((CHECKED_ON_FULL_NAME.has(allergen) ? raw : plain).replace(NOT_THIS_ALLERGEN[allergen] ?? /$^/, " ")),
    )
    .map(([allergen]) => allergen);
}

/**
 * An AI recipe kept on the phone (Saved, Recently viewed) with the allergens its own ingredients name added to its
 * list, as the server now does for every AI recipe. One saved before that check existed may list fewer than it
 * contains; this never removes one. Bundled recipes have reviewed lists and are left as they are.
 */
export function with_ingredient_allergens(recipe: Recipe): Recipe {
  const named = new Set(recipe.allergens);
  for (const line of [...recipe.ingredients.map((i) => i.item), recipe.cocktail?.garnish ?? ""])
    for (const allergen of named_in(line)) named.add(allergen);
  if (named.size === recipe.allergens.length) return recipe;
  const rank = (allergen: string) => (ALLERGEN_ORDER.includes(allergen) ? ALLERGEN_ORDER.indexOf(allergen) : ALLERGEN_ORDER.length);
  return { ...recipe, allergens: [...named].sort((a, b) => rank(a) - rank(b)) };
}
