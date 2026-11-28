// "Report this recipe" on the recipe screen. Google Play requires apps that make content with AI to let people
// report offensive results without leaving the app. A report is sent as a bug report with its reason, so it shows on
// the same private feedback dashboard; offensive or unsafe ones are flagged there for safety review.

import { scale_amount } from "../recipes/scale";

export type ReportReason = "offensive" | "unsafe" | "wrong_dish" | "inaccurate" | "other";

/** Same values and order the server accepts (server/feedback.js REPORT_REASONS). */
export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: "offensive", label: "Offensive or inappropriate" },
  { value: "unsafe", label: "Unsafe to follow" },
  { value: "wrong_dish", label: "Not the dish or drink in my photo" },
  { value: "inaccurate", label: "Wrong ingredients, steps or allergens" },
  { value: "other", label: "Something else" },
];

export const MAX_REPORT_DETAILS = 2000;
// Feedback descriptions are limited to 5,000 characters by server/feedback.js.
const MAX_REPORT_DESCRIPTION = 5000;
const MAX_TITLE = 120;

export type RecipeReportInput = {
  reason: ReportReason;
  dish: string;
  kind: "meal" | "cocktail";
  diet?: string | null;
  details: string;
  recipe?: {
    title: string;
    servings?: number;
    ingredients: { amount: string; unit: string; item: string }[];
    steps: string[];
    allergens: string[];
  };
  /** The serving count the person had chosen, so the snapshot shows the amounts they saw. */
  servings?: number;
};

/** The title and description the dashboard shows for one report. */
export function report_text({ reason, dish, kind, diet, details, recipe, servings }: RecipeReportInput): {
  title: string;
  description: string;
} {
  const prefix = "Recipe report: ";
  const name = dish.trim() || "Untitled recipe";
  const title = (prefix + name).length > MAX_TITLE ? `${(prefix + name).slice(0, MAX_TITLE - 1)}…` : prefix + name;
  const label = REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason;
  const lines = [
    `Reason: ${label}`,
    `Recipe: ${name} (${kind === "cocktail" ? "drink" : "meal"}${diet ? `, ${diet} version` : ""})`,
    `Details: ${details.trim().slice(0, MAX_REPORT_DETAILS) || "None given"}`,
  ];
  if (recipe) {
    const written = recipe.servings || 1;
    const shown = servings && servings > 0 ? servings : written;
    const factor = shown / written;
    lines.push("Displayed recipe snapshot:", `Title: ${recipe.title}`);
    lines.push(`Servings shown: ${shown}${shown === written ? "" : ` (recipe written for ${written}; amounts below are scaled)`}`);
    lines.push(
      "Ingredients:",
      ...recipe.ingredients.map((item) => `- ${[scale_amount(item.amount, factor), item.unit, item.item].filter(Boolean).join(" ")}`),
    );
    lines.push("Instructions:", ...recipe.steps.map((step, index) => `${index + 1}. ${step}`));
    lines.push(`Listed allergens: ${recipe.allergens.join(", ") || "None listed"}`);
  }
  const description = lines.join("\n");
  return {
    title,
    description:
      description.length <= MAX_REPORT_DESCRIPTION
        ? description
        : `${description.slice(0, MAX_REPORT_DESCRIPTION - 24)}\n[Snapshot truncated]`,
  };
}
