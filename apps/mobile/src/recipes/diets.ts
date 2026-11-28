// Which "Make it…" diet options a recipe gets, worked out from its ingredients and garnish (never its name alone).
//
// For each diet a recipe is one of:
//   fits    — nothing in the standard recipe breaks the diet, so it gets a label and no "Make it" option
//   option  — something breaks the diet and can be removed or swapped, so the option is offered
//   none    — what breaks the diet is the heart of the dish (named in its title, or a starch cooked into it for
//             low-carb), so no option is offered
//   review  — the only problem is an ingredient that depends on the brand or isn't specific enough (plain "broth",
//             wine and its fining, store-bought bread), so neither a label nor an option is shown until a person checks
//
// These are recipe checks, not allergy guarantees: removing an ingredient doesn't rule out cross-contact.
import { DIETS, type Diet, type Kind, type Recipe } from "./types";

export type DietStatus = "fits" | "option" | "none" | "review";
export type DietProfile = {
  /** Diets the standard recipe already meets: shown as labels. */
  fits: Diet[];
  /** Diets offered as "Make it…" options: each needs a real change to the recipe. */
  options: Diet[];
  /** Every diet that applies to this kind of dish, with the reason when it isn't a plain fit. */
  status: Partial<Record<Diet, { status: DietStatus; why: string }>>;
};
/** A hand decision for one bundled dish, made in the audit (see dietReview.json). */
export type DietOverride = { status: DietStatus; why: string };

type Rule = { bad: RegExp[]; unsure?: RegExp[]; core?: RegExp[]; raw?: boolean; qualified?: RegExp };

// A word in front of an ingredient that settles it for one diet: "vegan sweet vermouth", "gluten-free soy sauce".
// It covers up to three following words, and stops at "and", "or", "with" and "plus" so it can't hide the next item.
const VEGETARIAN_OK = /\b(?:vegan|plant-based|vegetarian|meatless)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g;
const VEGAN_OK = /\b(?:vegan|plant-based)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g;
const DAIRY_FREE_OK = /\b(?:vegan|plant-based|dairy-free)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g;
const GLUTEN_FREE_OK = /\bgluten-free(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g;
// "Almond-free" rules out only almonds, so it clears just its own word: "almond-free cashew milk" is still cashew.
const NUT_FREE_OK = /\b(?:nut-free|nut free)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}|\balmond-free\b/g;
// Cheeses made with animal rennet by tradition (Parmesan by law, cotija by custom): not vegetarian, but easy to swap.
const RENNET = /\b(?:parmesan|parmigiano|pecorino|grana padano|cotija)/i;

/** The first of the patterns found in the text. */
function first_match(text: string, patterns: RegExp[] | undefined): string | null {
  for (const p of patterns ?? []) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

// Animal flesh and things made from it. Generic broth, stock and some pastes may or may not contain it.
const MEAT =
  /\b(?:chicken|beef|pork|lamb|mutton|goat(?! cheese)|veal|duck|turkey|cornish hens?|oxtail|tripe|brisket|chuck|sirloin|ribeye|tenderloin|flank steak|steaks?|short ribs|spareribs|shank|bacon|pancetta|guanciale|prosciutto|ham\b|pepperoni|salami|chorizo|chouri[cç]o|lingui[cç]a|sausages?|kielbasa|andouille|bratwurst|lap cheong|lard|suet|marrow|bones?\b|doner|meat|gelatin|fish|salmon|trout|tuna|albacore|yellowfin|cod\b|haddock|catfish|tilapia|halibut|mahi|anchov|sardine|mackerel|eel\b|unagi|bonito|katsuobushi|dashi|saltfish|shrimp|prawn|crab|clams?\b|clamato|mussels?|lobster|scallops?|oyster sauce|squid|octopus|conch|crayfish|bagoong|belacan|terasi|ikan bilis|worcestershire|nuoc cham|ham hocks?)/i;
const MEAT_CORE_EXTRA = /\b(?:seafood|carne)/i;
const EGG_CORE = /\b(?:eggs?\b|omelet(?:te)?|frittata|huevos|quiche)/i;
const MEAT_UNSURE = /\b(?:broth|stock\b|stock cubes?|bouillon|kimchi|curry paste|laksa paste|nam prik pao|chili paste|sinigang|fish-free)/i;
// Kombu dashi, vegetable broth and the like are plant-based; "or" alternatives are handled separately.
const PLANT_WORDS =
  /\b(vegetable (?:broth|stock)|kombu dashi|mushroom dashi|eggplant|butter beans|butter lettuce|butternut|cocoa butter|peanut butter|cream of coconut|coconut (?:cream|milk)|honeydew|crème de [a-zûé]+|creme de [a-z]+|cream sherry|ginger beer|root beer)\b/g;

const DAIRY =
  /\b(?:butter|buttermilk|ghee|smen|kibbeh|milk|cream|crema|cheese|cheddar|mozzarella|parmesan|pecorino|kefalotyri|ricotta|feta|paneer|queso|quesillo|oaxaca|monterey jack|gruy[eè]re|provolone|swiss|yogh?urt|irish cream|mashed potatoes|naan|brioche|mascarpone|cr[eè]me fra[iî]che|kefir|quark|labneh|halloumi|burrata|custard|ice cream|dulce de leche|queso fresco|cotija|cheese curds)/i;
const DAIRY_UNSURE =
  /\b(?:bread|rolls|buns|pav|english muffins|puff pastry|pie crusts?|empanada dough|paratha|roti|cornbread|gingersnap|chocolate(?! bitters))/i;
const CHEESE =
  /\b(?:cheese|queso|paneer|mozzarella|ricotta|feta|halloumi|fondue|parmesan|parmigiana|cacio|provolone|burrata|mascarpone|cheese curds)/i;

const EGG = /\b(?:eggs?\b|egg (?:white|yolk)s?|yolks?|mayo|mayonnaise|tartar sauce|egg noodles|brioche|challah)/i;
const EGG_UNSURE = /\b(?:lasagna noodles|dumpling wrappers|spring roll wrappers|empanada dough|tempura bits|gingersnap)/i;
const HONEY = /\b(?:honey(?!dew|comb)|gardenia mix)/i;
// Lillet and Guinness are vegan across the brand (Barnivore, company emails 2018 and 2021–22).
// Wine, beer and some aperitifs may be fined with egg, milk, gelatin or fish products: it depends on the brand.
const FINED = /\b(?:wine|champagne|prosecco|vermouth|sherry|port\b|beer|lager|stout|dubonnet|marsala|sake|shaoxing)/i;

const GLUTEN =
  /\b(?:wheat(?!-free\b)|flour|atta|semolina|couscous|bulgur|bread|breadcrumbs|panko|croutons|pitas?|pide|naan|roti|paratha|rougag|flatbread|baguettes?|rolls|buns|pav|brioche|challah|english muffins|cornbread|injera|dough|pastry|pie crusts?|wrappers|mandarin pancakes|gingersnap|saltine|crackers|pasta|spaghetti|fettuccine|linguine|macaroni|ziti|rigatoni|penne|trofie|lasagna|noodles|ramen|udon|soba|lo mein|vermicelli|tortillas?|oats|soy sauce|maggi|hoisin|oyster sauce|kecap manis|sweet soy|sweet bean sauce|doubanjiang|gochujang|black vinegar|malt vinegar|shaoxing|tempura|tonkatsu sauce|okonomiyaki sauce|takoyaki sauce|beer|lager|stout|guinness|split pea fritters|ladyfingers|savoiardi|biscuits|cookies|cake|graham|wafers|phyllo|filo|croissants?|bagels?|muffins?|matzo|barley|farro|spelt|orzo|gnocchi|seitan|churros?|cr[eê]pes?|dumplings?|wontons?|gyoza|bao|pancakes?|waffles?|brownies?|shortcrust)/i;
// Not wheat, barley or rye, though their names look like it.
const GLUTEN_FREE_WORDS =
  /\b(rice (?:flour|noodles|vermicelli|paper|cakes)|chickpea flour|corn (?:tortillas?|flour)|taco shells or corn tortillas|tortilla (?:chips|strips)|glass noodles|sweet potato starch noodles|flat rice noodles|fresh (?:flat|wide) rice noodles|rice vermicelli|thin rice vermicelli|dried flat rice noodles|tamari|ginger beer|root beer|bread and butter pickles|masa harina|cylindrical rice cakes|prawn crackers)\b/g;
// Miso is usually made with rice or soybeans alone, but barley (mugi) miso and some blends contain barley or wheat.
const GLUTEN_UNSURE =
  /\b(?:miso|worcestershire|bouillon|stock cubes?|barbecue sauce|taco seasoning|fried onions|fermented black beans|fish cakes|sausages?|kielbasa|andouille|bratwurst|lap cheong|chinese sausage|sambar powder|prawn crackers|chocolate syrup)/i;

const NUTS =
  /\b(?:peanuts?|almonds?|walnuts?|pecans?|cashews?|pistachios?|pine nuts|hazelnuts?|macadamia|brazil nuts?|orgeat|frangelico|nocino|praline|marzipan|pesto|satay|coconut|kerisik|malibu)/i;
const NUTS_CORE =
  /\b(?:peanuts?|almonds?|walnuts?|pecans?|cashews?|pistachios?|pine nuts|hazelnuts?|macadamia|brazil nuts?|orgeat|frangelico|nocino|praline|marzipan|pesto|coconut|kerisik|malibu)/i;
// These depend on the brand: falernum is often made with almond, amaretto with almond or apricot kernel, nougat and
// mole paste often hold nuts. Unless the line itself says nut-free ("nut-free amaretto"), nut-free isn't claimed.
const NUTS_UNSURE = /\b(?:amaretto|noyaux|falernum|nougat|mole paste|nut liqueur)/i;

// Low-carb: a starch cooked into the dish is its heart; sugar, a coating or a side can be cut or swapped.
const STARCH =
  /\b(?:wheat(?!-free\b)|flour|atta|semolina|couscous|bulgur|bread|breadcrumbs|panko|croutons|pitas?|pide|naan|roti|paratha|rougag|flatbread|baguettes?|rolls|buns|pav|brioche|challah|english muffins|cornbread|injera|dough|pastry|pie crusts?|wrappers|mandarin pancakes|gingersnap|saltine|crackers|pasta|spaghetti|fettuccine|linguine|macaroni|ziti|rigatoni|penne|trofie|lasagna|noodles|ramen|udon|soba|lo mein|vermicelli|tortillas?|oats|tempura|split pea fritters|rice|potato(?:es)?|hash browns|french fries|plantains?|yams?\b|cassava|yuca|taro|corn\b|cornmeal|masarepa|masa|grits|hominy|polenta|beans|black-eyed peas|chickpeas|lentils|dal\b|split peas|quinoa|farofa|dosa batter|idli batter|tortilla chips|tortilla strips|taco shells|tteok|rice cakes|plantain chips|injera|ladyfingers|savoiardi|biscuits|cookies|cake|graham|phyllo|filo|croissants?|bagels?|barley|farro|orzo|gnocchi|churros?|cr[eê]pes?|wontons?|gyoza|bao)/i;
const SUGAR =
  /\b(?:sugar|honey|syrup|molasses|jam\b|marmalade|chutney|ketchup|hoisin|kecap manis|sweet soy|sweet chili sauce|barbecue sauce|mirin|raisins|dates|prunes|apricots|jujubes|grenadine|cola|soda\b(?! water)|club soda|ginger ale|ginger beer|tonic|lemonade|falernum|beer|lager|stout|guinness)/i;
// In a drink, these carry the flavor, so a low-carb version would be a different drink.
const DRINK_CARB_CORE =
  /\b(?:liqueur|cura[cç]ao|triple sec|cointreau|grand marnier|chambord|kahl[uú]a|drambuie|galliano|b[eé]n[eé]dictine|chartreuse|st-germain|aperol|campari|amaro|amer picon|cynar|fernet|j[aä]germeister|southern comfort|irish cream|amaretto|cr[eè]me de|schnapps|sloe gin|allspice dram|pernod|sweet vermouth|blanc vermouth|dubonnet|lillet|port\b|cream sherry|beer|lager|stout|guinness|juice(?<!lime juice|lemon juice)|puree|cream of coconut|coconut rum|spiced rum|vanilla vodka|chocolate(?! bitters)|strawberries|blackberries|raspberries|berries|banana|pineapple|peach|grapes|sake|orgeat|sangrita|lemonade|midori|maraschino|absinthe|apricot brandy|peach brandy|cherry heering)/i;
const STARCH_CORE_TITLE =
  /\b(?:rice|risotto|paella|biryani|pilaf|polo|jollof|pasta|spaghetti|lasagna|macaroni|noodles?|ramen|pho|udon|lo mein|pad|bread|toast|sandwich|burger|pizza|potato(?:es)?|fries|tacos?|burrito|quesadilla|enchiladas?|tamales?|empanadas?|dumplings?|pancakes?|waffles?|beans|dal|lentils?|chickpeas?)/i;

function rule(diet: Diet): Rule | null {
  switch (diet) {
    case "vegetarian":
      return { bad: [MEAT, RENNET], unsure: [MEAT_UNSURE], core: [MEAT, MEAT_CORE_EXTRA], qualified: VEGETARIAN_OK };
    case "vegan":
      return {
        bad: [MEAT, DAIRY, EGG, HONEY],
        unsure: [MEAT_UNSURE, DAIRY_UNSURE, EGG_UNSURE, FINED],
        core: [MEAT, MEAT_CORE_EXTRA, CHEESE, EGG_CORE],
        qualified: VEGAN_OK,
      };
    case "dairy-free":
      return { bad: [DAIRY], unsure: [DAIRY_UNSURE], core: [CHEESE], qualified: DAIRY_FREE_OK };
    case "gluten-free":
      return { bad: [GLUTEN], unsure: [GLUTEN_UNSURE], qualified: GLUTEN_FREE_OK };
    case "nut-free":
      return { bad: [NUTS], unsure: [NUTS_UNSURE], core: [NUTS_CORE], raw: true, qualified: NUT_FREE_OK };
    default:
      return null;
  }
}

const clean = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFC")
    .replace(PLANT_WORDS, (m) => (/vegan|plant-based/.test(m) ? " plant " : " ok "));

/** An ingredient's own wording says it can be left out. */
const REMOVABLE =
  /\b(optional|to serve|for serving|to garnish|for garnish|for dipping|for the glass|to rim|for the rim|for rinsing|to float)\b/;

// A later "or" choice only counts when it names a real substitute, so "chicken breasts or thighs" is still chicken.
const SUBSTITUTE =
  /\b(vegan|plant-based|vegetarian|gluten-free|dairy-free|nut-free|water|oil|vegetable|mushrooms?|tofu|beans|avocado|maple|agave|sparkling|soda water|tamari|cauliflower|corn tortillas|rice|lime|lemon|juice|salsa|sour cream|plant|ok|grapefruit soda|pineapple juice|extra broth|simple syrup)\b/;

/** The "or" choices in an ingredient line that name a real substitute ("water or chicken broth" → "water"). */
function substitutes(text: string): string[] {
  const main = text.replace(/\([^)]*\)/g, (m) => (/\bor\b/.test(m) ? m.replace(/[()]/g, " ") : m));
  const parts = main.split(/\s+or\s+/);
  return parts.length > 1 ? parts.filter((a) => SUBSTITUTE.test(clean(a))) : [];
}

type LineCheck = { verdict: "ok" | "unsure" | "bad"; hit: string; removable: boolean };

function check_text(text: string, r: Rule, gluten: boolean): Omit<LineCheck, "removable"> {
  // Nut checks read the words as written: coconut milk and peanut butter are not dairy, but they are nuts here.
  // A brand suggestion in brackets ("(such as Mionetto Organic Prosecco)") names a product, not another ingredient.
  const named = text.replace(/\(such as [^)]*\)/gi, " ");
  const plain = r.qualified ? named.toLowerCase().replace(r.qualified, " ok ") : named;
  const base = r.raw ? plain.toLowerCase().replace(/\b(butternut|nutmeg)\b/g, " ") : clean(plain);
  const t = gluten ? base.replace(GLUTEN_FREE_WORDS, " ok ") : base;
  const bad = first_match(t, r.bad);
  if (bad) return { verdict: "bad", hit: bad };
  const unsure = first_match(t, r.unsure);
  if (unsure) return { verdict: "unsure", hit: unsure };
  return { verdict: "ok", hit: "" };
}

function check_line(text: string, r: Rule, gluten: boolean): LineCheck {
  const removable = REMOVABLE.test(text.toLowerCase());
  const whole = check_text(text, r, gluten);
  if (whole.verdict === "ok") return { ...whole, removable };
  return { ...whole, removable };
}

function lines(recipe: Recipe): string[] {
  const out = recipe.ingredients.map((i) => `${i.item}`.trim());
  if (recipe.cocktail?.garnish) out.push(`${recipe.cocktail.garnish} (to garnish)`);
  return out;
}

function check_diet(recipe: Recipe, diet: Diet, has_version: boolean): { status: DietStatus; why: string } {
  const r = rule(diet)!;
  const checks = lines(recipe).map((l) => ({ line: l, ...check_line(l, r, diet === "gluten-free") }));
  const bad = checks.filter((c) => c.verdict === "bad");
  const unsure = checks.filter((c) => c.verdict === "unsure");
  if (!bad.length && !unsure.length) return { status: "fits", why: "" };
  if (!bad.length) return { status: "review", why: `check ${unsure.map((c) => `"${c.line}"`).join(", ")}` };
  if (has_version) return { status: "option", why: "hand-written version" };
  // When the title names what breaks the diet ("Beef Pho", "Cheese Fondue"), removing it makes a different dish.
  const named = first_match(clean(recipe.title), r.core);
  if (named && bad.some((c) => !c.removable)) return { status: "none", why: `the dish is defined by its ${named}` };
  return { status: "option", why: bad.map((c) => c.hit).join(", ") };
}

/**
 * True when an ingredient may hold the allergen by the wider diet word lists: they name more of its sources
 * (mascarpone, custard, brioche) than the short allergen lists do, and include the uncertain ones.
 */
export function diet_words_suggest(item: string, allergen: string): boolean {
  const words: Record<string, RegExp[]> = {
    milk: [DAIRY, DAIRY_UNSURE],
    eggs: [EGG, EGG_UNSURE],
    wheat: [GLUTEN],
    "tree nuts": [NUTS, NUTS_UNSURE],
    peanuts: [NUTS],
  };
  const text = item.toLowerCase().normalize("NFC");
  return (words[allergen] ?? []).some((w) => w.test(text));
}

/** Rough amount in cups, for telling a spoon of sugar or flour from a dessert's or a dough's worth. */
export function cups(amount: string, unit: string): number {
  const parts = amount
    .trim()
    .split(/[-–]| to /)[0]
    .trim()
    .split(/\s+/);
  let n = 0;
  for (const p of parts) {
    const f = p.match(/^(\d+)\/(\d+)$/);
    if (f) n += Number(f[1]) / Number(f[2]);
    else if (/^\d+(\.\d+)?$/.test(p)) n += Number(p);
  }
  const u = unit.toLowerCase();
  if (/^cups?$/.test(u)) return n;
  if (/^tbsp|tablespoons?$/.test(u)) return n / 16;
  if (/^tsp|teaspoons?$/.test(u)) return n / 48;
  if (/^(lb|lbs|pounds?)$/.test(u)) return n * 2;
  if (/^(oz|ounces?)$/.test(u)) return n / 8;
  if (/^(g|grams?)$/.test(u)) return n / 200;
  if (/^(kg)$/.test(u)) return n * 5;
  return 0;
}

// Words that look like a starch or sugar but aren't one here.
const NOT_CARB =
  /\b((?:low-carb|diet|keto)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}|sugar-free (?:simple syrup|syrup|sugar|sweetener|tonic water|tonic|ginger beer|ginger ale|cola|soda|lemonade|grenadine)|garam masala|nihari masala|[a-z ]*masala|rice (?:vinegar|wine)|for the dough|pasta water|noodle water|corn husks|(?:long|green|fermented black|coffee) beans|honeycomb|corn oil|cornish)\b/g;
// Condiments with some sugar: they can be swapped for sugar-free ones, so they never make a dish "none".
const CONDIMENT = /\b(ketchup|barbecue sauce|hoisin|kecap manis|sweet soy|sweet chili sauce|mirin|chutney)\b/;

function check_low_carb(recipe: Recipe, kind: Kind): { status: DietStatus; why: string } {
  const starch = STARCH;
  const sugar = SUGAR;
  const drink_core = DRINK_CARB_CORE;
  const servings = Math.max(1, recipe.servings);
  // Leavening means a batter or dough: cakes, cookies, pancakes, breads.
  const baked = recipe.ingredients.some((i) => /\b(baking (?:powder|soda)|yeast)\b/i.test(i.item));
  const found: { hit: string; core: boolean }[] = [];
  for (const i of recipe.ingredients) {
    const text = i.item.toLowerCase().replace(NOT_CARB, " ");
    const alts = [text, ...substitutes(text)];
    // Any choice without carbs ("rice or cauliflower") means the standard recipe already allows it.
    const carby = alts.every((a) => {
      const t = a.replace(GLUTEN_FREE_WORDS, (m) => m.replace(/rice|corn|tortilla|noodles|potato/g, "starch"));
      return starch.test(t) || sugar.test(t) || (kind === "cocktail" && drink_core.test(t)) || /starch/.test(t);
    });
    if (!carby) continue;
    const removable = REMOVABLE.test(text) || /\b(for dusting|for the peel|for rolling|for frying|for coating)\b/.test(text);
    if (kind === "cocktail") {
      found.push({ hit: i.item, core: drink_core.test(text) && !removable });
      continue;
    }
    const total = cups(i.amount, i.unit);
    const is_starch = starch.test(text) || /starch/.test(text);
    // Flour, cornstarch or crumbs for a coating or a sauce can be swapped; flour in a batter or dough can't.
    const coating = /^(all-purpose |plain |fine dry |fine |italian |panko )?(flour|cornstarch|breadcrumbs|panko)/.test(text) && !baked;
    const big_sugar = sugar.test(text) && !CONDIMENT.test(text) && (total >= 0.5 || total / servings >= 0.125);
    found.push({ hit: i.item, core: !removable && ((is_starch && !coating) || big_sugar) });
  }
  if (!found.length) return { status: "fits", why: "" };
  const title = clean(recipe.title);
  const core = found.find((f) => f.core) ?? (STARCH_CORE_TITLE.test(title) && kind === "meal" ? found[0] : undefined);
  if (core) return { status: "none", why: `"${core.hit}" is the heart of the dish` };
  return { status: "option", why: found.map((f) => f.hit).join(", ") };
}

/**
 * The diet labels and "Make it…" options for a recipe. hand_versions are the diets with hand-written versions
 * (vegetarian and vegan for some bundled dishes); overrides are the audit's decisions for one bundled dish.
 */
export function diet_profile(
  recipe: Recipe,
  kind: Kind,
  hand_versions: readonly Diet[] = [],
  overrides: Partial<Record<Diet, DietOverride>> = {},
): DietProfile {
  const status: DietProfile["status"] = {};
  for (const diet of DIETS) {
    if (diet === "non-alcoholic") {
      if (kind !== "cocktail" || !recipe.cocktail) continue;
      status[diet] = recipe.cocktail.alcoholic ? { status: "option", why: "alcoholic drink" } : { status: "fits", why: "" };
    } else if (diet === "low-carb") {
      status[diet] = check_low_carb(recipe, kind);
    } else {
      status[diet] = check_diet(recipe, diet, hand_versions.includes(diet));
    }
  }
  // A vegan version can't keep what a vegetarian one can't lose.
  if (status.vegetarian?.status === "none" && status.vegan?.status === "option" && !hand_versions.includes("vegan"))
    status.vegan = { ...status.vegetarian };
  for (const [diet, o] of Object.entries(overrides) as [Diet, DietOverride][]) if (status[diet]) status[diet] = o;
  // Nut-free is an allergy claim, so the description and method must agree with it too: a recipe whose words mention a
  // nut its ingredients don't list ("lime, grapefruit, almond and warm spice", often from an AI) isn't called nut-free
  // until a person checks. Flavor words ("almond-scented") describe a taste, not an ingredient.
  if (status["nut-free"]?.status === "fits") {
    const said = [recipe.description, ...recipe.steps].join(" ").replace(/\b[a-z]+-(?:flavou?red|scented|like|free)\b/gi, " ");
    const mention = check_text(said, rule("nut-free")!, false);
    if (mention.verdict === "bad") status["nut-free"] = { status: "review", why: `the description or method mentions ${mention.hit}` };
  }
  // A drink written only as a method (a hand-written alcohol-free version, curatedVersions.ts) has no ingredient list
  // to check, so no diet is claimed for it: each one needs a person to check, and can still be asked for.
  if (!recipe.ingredients.length)
    for (const diet of DIETS)
      if (diet !== "non-alcoholic" && status[diet])
        status[diet] = { status: "review", why: "written as a method, without an ingredient list" };
  // A changed dish may still be useful: let people request an adaptation even if a defining ingredient changes.
  for (const diet of ["vegetarian", "vegan", "dairy-free", "nut-free"] as Diet[]) {
    if (status[diet]?.status === "none") status[diet] = { status: "option", why: "requires a substitution" };
  }
  const pick = (s: DietStatus) => DIETS.filter((d) => status[d]?.status === s);
  return { fits: pick("fits"), options: pick("option"), status };
}
