// Cook mode warns about brand-dependent allergens the same way the recipe screen and shared text do
// (2026-11-27 E2E regression test of main, finding F1).
import { createRequire } from "node:module";
import { createElement, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { recipe_as_text } from "../src/recipes/format";
import type { Recipe } from "../src/recipes/types";

type Rendered = { toJSON: () => unknown; unmount: () => void };
const { act, create } = createRequire(import.meta.url)("react-test-renderer") as {
  act: (fn: () => void | Promise<void>) => Promise<void>;
  create: (node: ReactElement) => Rendered;
};
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../src/AppContext", () => ({ useApp: () => ({ current: mocks.current }) }));
vi.mock("expo-router", () => ({ router: { back: vi.fn() }, useLocalSearchParams: () => ({}) }));
vi.mock("expo-keep-awake", () => ({ useKeepAwake: () => {} }));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  TextInput: "TextInput",
}));
vi.mock("../src/ui/theme", () => ({
  Button: "Button",
  useTheme: () => ({ colors: {}, type: { body: {}, muted: {}, heading: {}, title: {} } }),
}));
const { default: CookScreen } = await import("../src/app/cook");

const drink = (allergens: string[], items: string[]): Recipe => ({
  title: "Amaretto sour",
  description: "A sour.",
  servings: 1,
  prep_minutes: 3,
  cook_minutes: 0,
  ingredients: items.map((item) => ({ amount: "1", unit: "oz", item })),
  steps: ["Shake with ice.", "Strain."],
  allergens,
  cocktail: { glass: "rocks", garnish: "cherry", alcoholic: true, non_alcoholic_version: null },
  note: "",
});
let tree: Rendered | undefined;
async function cook(recipe: Recipe) {
  mocks.current = { status: "ready", kind: "cocktail", recipe };
  await act(async () => {
    tree = create(createElement(CookScreen));
  });
  return JSON.stringify(tree!.toJSON());
}
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
});

it("shows the May-contain line that the recipe screen and shared text show", async () => {
  const recipe = drink([], ["amaretto", "lemon juice"]);
  const screen = await cook(recipe);
  expect(screen).toContain("None listed");
  expect(screen).toContain("May contain tree nuts (amaretto)");
  expect(recipe_as_text(recipe)).toContain("May contain tree nuts (amaretto)");
});

it("adds nothing when the allergen is already listed or the line says nut-free", async () => {
  expect(await cook(drink(["tree nuts"], ["amaretto", "lemon juice"]))).not.toContain("May contain");
  await act(async () => tree?.unmount());
  expect(await cook(drink([], ["nut-free amaretto", "lemon juice"]))).not.toContain("May contain");
});
