// Scales US recipe amounts like "1 1/2", "3/4", "½", "2-3" or "6 to 8" for the servings counter.
// Anything that isn't a plain number (for example "a pinch") is left exactly as written.

const UNICODE_FRACTIONS: Record<string, number> = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

/** "1 1/2" → 1.5, "½" → 0.5, "2" → 2, "0.25" → 0.25; null when it isn't a single number. */
export function parse_quantity(text: string): number | null {
  const t = text.trim();
  let m = /^(\d+)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/.exec(t);
  if (m) return Number(m[1]) + UNICODE_FRACTIONS[m[2]];
  if (t in UNICODE_FRACTIONS) return UNICODE_FRACTIONS[t];
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m && Number(m[3]) > 0) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

// Kitchen-friendly fractions, in eighths and thirds.
const NICE: [number, string][] = [
  [0, ""],
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 3, "1/3"],
  [3 / 8, "3/8"],
  [1 / 2, "1/2"],
  [5 / 8, "5/8"],
  [2 / 3, "2/3"],
  [3 / 4, "3/4"],
  [7 / 8, "7/8"],
  [1, ""],
];

export function format_quantity(value: number): string {
  if (value >= 10) return String(Math.round(value));
  let whole = Math.floor(value);
  const rest = value - whole;
  let best = NICE[0];
  for (const candidate of NICE) if (Math.abs(candidate[0] - rest) < Math.abs(best[0] - rest)) best = candidate;
  if (best[0] === 1) whole += 1;
  if (!best[1]) return String(whole || (value > 0 ? "1/8" : "0"));
  return whole ? `${whole} ${best[1]}` : best[1];
}

/** Scales "2", "1 1/2" or a range like "2-3" or "6 to 8"; returns the original text when it can't be scaled. */
export function scale_amount(amount: string, factor: number): string {
  if (factor === 1 || !amount.trim()) return amount;
  const range = /^(.+?)\s*(?:[-–]|\bto\b)\s*(.+)$/.exec(amount.trim());
  if (range) {
    const [a, b] = [parse_quantity(range[1]), parse_quantity(range[2])];
    const joiner = /\bto\b/.test(amount) ? " to " : "-";
    if (a !== null && b !== null) return `${format_quantity(a * factor)}${joiner}${format_quantity(b * factor)}`;
  }
  const n = parse_quantity(amount);
  return n === null ? amount : format_quantity(n * factor);
}
