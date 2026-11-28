// Made by scripts/make_collection.py from data/curated-photos. Do not edit by hand; run the script.

/** How many hand-picked cover photos the app has. */
export const CURATED_COUNT = 702;

/** One photo on the wall: the dish it shows, and the bundled picture. */
export type WallPhoto = { name: string; kind: "meal" | "cocktail"; source: number };

/** The two rows of photos on the Home screen's moving photo wall. */
export const WALL_ROWS: WallPhoto[][] = [
  [
    { name: "Ramen", kind: "meal", source: require("../../assets/collection/ramen.jpg") },
    { name: "Aperol Spritz", kind: "cocktail", source: require("../../assets/collection/aperol-spritz.jpg") },
    { name: "Chicken tikka masala", kind: "meal", source: require("../../assets/collection/chicken-tikka-masala.jpg") },
    { name: "Cosmopolitan", kind: "cocktail", source: require("../../assets/collection/cosmopolitan.jpg") },
    { name: "Pepperoni pizza", kind: "meal", source: require("../../assets/collection/pepperoni-pizza.jpg") },
    { name: "Mojito", kind: "cocktail", source: require("../../assets/collection/mojito.jpg") },
    { name: "Pho", kind: "meal", source: require("../../assets/collection/pho.jpg") },
    { name: "Negroni", kind: "cocktail", source: require("../../assets/collection/negroni.jpg") },
  ],
  [
    { name: "Old Fashioned", kind: "cocktail", source: require("../../assets/collection/old-fashioned.jpg") },
    { name: "Paella", kind: "meal", source: require("../../assets/collection/paella.jpg") },
    { name: "Margarita", kind: "cocktail", source: require("../../assets/collection/margarita.jpg") },
    { name: "Fish tacos", kind: "meal", source: require("../../assets/collection/fish-tacos.jpg") },
    { name: "Espresso Martini", kind: "cocktail", source: require("../../assets/collection/espresso-martini.jpg") },
    { name: "Lasagna", kind: "meal", source: require("../../assets/collection/lasagna.jpg") },
    { name: "Blue Hawaii", kind: "cocktail", source: require("../../assets/collection/blue-hawaii.jpg") },
    { name: "Shrimp scampi", kind: "meal", source: require("../../assets/collection/shrimp-scampi-pasta.jpg") },
  ],
];
