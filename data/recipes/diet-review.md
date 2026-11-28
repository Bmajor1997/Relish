# Diet options: items that need a person to check

Made by `scripts/diet_review_doc.py` from the audit in `apps/mobile/tests/dietAudit.test.ts` (rules in
`apps/mobile/src/recipes/diets.ts`, hand decisions in `apps/mobile/src/recipes/dietReview.json`).
Until an item here is checked, the app shows **neither** an "Already …" label **nor** a "Make it …" option
for that diet. To settle one, name a checked brand in the recipe ("vegan sweet vermouth (such as Dolin Rouge)")
or add a decision for it to `dietReview.json` (`fits`, `option` or `none`, with the reason).

## Totals

Options shown before the audit: 4568 (every diet on every recipe). Now: 1564.

| Diet | Already fits | Option | Can't be adapted | Needs review |
|---|---|---|---|---|
| vegetarian | 444 | 258 | 0 | 0 |
| vegan | 343 | 355 | 0 | 4 |
| gluten-free | 495 | 202 | 0 | 5 |
| dairy-free | 518 | 166 | 0 | 18 |
| nut-free | 629 | 63 | 0 | 10 |
| low-carb | 42 | 164 | 496 | 0 |
| non-alcoholic | 0 | 356 | 0 | 0 |

## Rules used

- Decided from each recipe's ingredients and garnish, never its name alone. An ingredient line's "X or Y" counts as fitting when Y is a real substitute ("butter or oil").
- A word in front of an ingredient settles it for that diet only: "vegan sweet vermouth", "gluten-free soy sauce", "dairy-free panko", "nut-free amaretto", "sugar-free simple syrup".
- An option is offered only when something must change. It is not offered when what breaks the diet is the heart of the dish: named in the title ("Beef Pho", "Cheese Omelet") or marked by hand in `dietReview.json` (ceviche, piña colada, fesenjan…).
- Vegetarian: no meat, fish or gelatin, and no Parmesan or pecorino (animal rennet); a vegetarian hard cheese is the swap.
- Low-carb (Ben's choice): already low-carb with no grains, bread, pasta, rice, potatoes, corn, beans, sugar, syrup, juice or sweet liqueur. Offered when the carbs are sugar, a sauce thickener, a coating or a side; not when a starch or batter is the dish, or a liqueur or juice carries a drink.
- Nut-free (Ben's choice): peanuts, tree nuts and coconut all count.
- Gluten: distilled spirits (whisky, vodka) and ginger beer count as gluten-free; beer, soy sauce, malt vinegar and wheat products don't.
- Non-alcoholic: offered only for alcoholic drinks (every drink in the collection is alcoholic).
- Labels and options are recipe checks, not allergy guarantees: they don't cover cross-contact, and brands change their recipes.

## Brands named in the recipes

| Brand | Settles | Source |
|---|---|---|
| Dolin vermouth (Rouge, Dry, Blanc) | vegan | Barnivore, company email Sept 2024; Waitrose label |
| Lillet (all) | vegan | Barnivore, company email Apr 2018; lillet.com |
| Guinness (all) | vegan | Barnivore, company emails 2021–22 |
| Miller High Life | vegan | Barnivore, MillerCoors email |
| Moët & Chandon Champagne | vegan | Barnivore, company email |
| Mionetto Organic Prosecco | vegan | US retail label (Hannaford) |
| Tio Pepe fino sherry | vegan | Barnivore, González Byass email Feb 2022; Ocado label |
| La Gitana manzanilla | vegan | Enotria and Laithwaites labels |
| Harveys amontillado | vegan | Enotria label |
| Barbadillo Oloroso Seco | vegan | Grapevine label |
| Cockburn's Special Reserve port | vegan | Barnivore, company email May 2019 |
| Bonterra white wines | vegan | Bonterra site; Barnivore company email |
| Yellow Tail red wines | vegan | Healthline and Domino, citing Barnivore |
| Disaronno | nut-free | AAAAI Ask the Expert; Disaronno statement |
| Lea & Perrins Worcestershire (US) | gluten-free | Kraft Heinz product page |
| Hershey's chocolate syrup | gluten-free | Hershey's label |
| McCormick Gluten Free Taco Seasoning | gluten-free | McCormick; certified gluten-free (contains milk) |
| Aidells Cajun Style andouille | gluten-free | Aidells label |
| Herb-Ox bouillon | gluten-free | Celiac.com brand list |
| Ibarra Mexican chocolate | dairy-free | ingredients: sugar, cacao, soy lecithin, cinnamon |
| Kikkoman panko (plain) | dairy-free | Kikkoman ingredients: wheat flour, sugar, yeast, salt |

## Still to check: Vegan (4)

- **Fried Spring Rolls**: check "spring roll wrappers"
- **Hummus**: check "warm pita bread, to serve"
- **Shawarma-Spiced Chickpea Pitas**: check "wheat pita breads"
- **Zaza**: check "Dubonnet Rouge"

## Still to check: Gluten-free (5)

- **Brazilian Feijoada**: check "smoked sausage (linguiça), sliced"
- **Idli Sambar**: check "sambar powder"
- **Miso Soup**: check "miso paste (white or red), plus more to taste"
- **Miso-Glazed Eggplant Rice Bowls**: check "white miso"
- **Oven-Baked BBQ Ribs**: check "barbecue sauce"

## Still to check: Dairy-free (18)

- **BLT Sandwich**: check "sandwich bread, toasted"
- **Beef Empanadas**: check "empanada dough rounds"
- **Bigos (Polish Hunter's Stew)**: check "rye bread or boiled potatoes, to serve"
- **Caldo Verde (Portuguese Kale Soup)**: check "black pepper and crusty cornbread (broa), to serve"
- **Chickpea Spinach Shakshuka**: check "wheat pita breads"
- **Choripán**: check "crusty rolls"
- **Crispy Coconut Fish with Mango Salsa**: check "panko breadcrumbs"
- **Hummus**: check "warm pita bread, to serve"
- **Lemon Garlic Turkey Meatballs and Bulgur**: check "plain wheat breadcrumbs"
- **Mole Poblano**: check "bread, torn"
- **Pork Banh Mi**: check "Vietnamese baguettes or soft French rolls"
- **Pork Meatballs with Ginger Broth**: check "plain wheat breadcrumbs"
- **Pork Schnitzel**: check "fine dry breadcrumbs"
- **Pulled Pork Sandwich**: check "soft buns"
- **Sauerbraten**: check "gingersnap cookies, crushed"
- **Shawarma-Spiced Chickpea Pitas**: check "wheat pita breads"
- **Sri Lankan Kottu Roti**: check "paratha or roti, cut into thin strips"
- **Turkey Club Sandwich**: check "sandwich bread, toasted"

## Still to check: Nut-free (10)

- **Chartreuse Swizzle**: check "falernum"
- **Corn 'n' Oil**: check "falernum"
- **Illegal**: check "falernum"
- **Pearl Diver**: check "falernum"
- **Pink Squirrel**: check "crème de noyaux"
- **Royal Bermuda Yacht Club**: check "falernum"
- **Tangerine Pink Pepper Gin Collins**: pink peppercorn can cross-react with cashew or pistachio allergy; this recipe is not verified nut-free
- **Test Pilot**: check "velvet falernum"
- **Three Dots and a Dash**: check "velvet falernum"
- **Zombie**: check "falernum"
