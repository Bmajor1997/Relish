// The shared cover-photo library: one polished, CREME-style photo per dish or drink, created once and reused
// by everyone. The person's own photo is never used here; only the dish's name and kind reach the image model.
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AiLimitError } from "./errors.js";

export const IMAGE_STYLE_VERSION = "v1";
const RESPONSES_URL = "https://api.openai.com/v1/images/generations";
const FILE_NAME = /^[a-f0-9]{32}\.jpg$/;
const RETRY_FAILED_AFTER_MS = 10 * 60_000;
const GENERATION_TIMEOUT_MS = 150_000;

/** "Chicken Parmesan!" and "chicken  parmesan" share one photo. */
export function normalize_dish_name(name) {
  if (typeof name !== "string") return null;
  const clean = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9&' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean && clean.length <= 80 ? clean : null;
}

export function image_key(kind, name) {
  const normal = normalize_dish_name(name);
  if (!normal || !["meal", "cocktail"].includes(kind)) return null;
  return createHash("sha256").update(`${IMAGE_STYLE_VERSION}|${kind}|${normal}`).digest("hex").slice(0, 32);
}

const CURATED_DIR = fileURLToPath(new URL("../data/curated-photos/", import.meta.url));

// Short, plain wording for recipe details placed into the prompt (glass, garnish, ingredients).
const detail = (text, max = 40) => {
  const clean = normalize_dish_name(String(text ?? "").split(/[,(;]/)[0]);
  return clean && clean.length <= max ? clean : null;
};

// The photo's diet note uses the app's own diet words (apps/mobile/src/recipes/diets.ts, copied exactly; a test keeps
// them in step and checks every library recipe), so it is never less careful than the app's labels. A note is only
// added when nothing could break the diet, uncertain items included ("broth", "dashi", wine): otherwise none is given.
const RENNET = /\b(?:parmesan|parmigiano|pecorino|grana padano|cotija)/i;
const MEAT = /\b(?:chicken|beef|pork|lamb|mutton|goat(?! cheese)|veal|duck|turkey|cornish hens?|oxtail|tripe|brisket|chuck|sirloin|ribeye|tenderloin|flank steak|steaks?|short ribs|spareribs|shank|bacon|pancetta|guanciale|prosciutto|ham\b|pepperoni|salami|chorizo|chouri[cç]o|lingui[cç]a|sausages?|kielbasa|andouille|bratwurst|lap cheong|lard|suet|marrow|bones?\b|doner|meat|gelatin|fish|salmon|trout|tuna|albacore|yellowfin|cod\b|haddock|catfish|tilapia|halibut|mahi|anchov|sardine|mackerel|eel\b|unagi|bonito|katsuobushi|dashi|saltfish|shrimp|prawn|crab|clams?\b|clamato|mussels?|lobster|scallops?|oyster sauce|squid|octopus|conch|crayfish|bagoong|belacan|terasi|ikan bilis|worcestershire|nuoc cham|ham hocks?)/i;
const MEAT_UNSURE = /\b(?:broth|stock\b|stock cubes?|bouillon|kimchi|curry paste|laksa paste|nam prik pao|chili paste|sinigang|fish-free)/i;
const PLANT_WORDS = /\b(vegetable (?:broth|stock)|kombu dashi|mushroom dashi|eggplant|butter beans|butter lettuce|butternut|cocoa butter|peanut butter|cream of coconut|coconut (?:cream|milk)|honeydew|crème de [a-zûé]+|creme de [a-z]+|cream sherry|ginger beer|root beer)\b/g;
const DAIRY = /\b(?:butter|buttermilk|ghee|smen|kibbeh|milk|cream|crema|cheese|cheddar|mozzarella|parmesan|pecorino|kefalotyri|ricotta|feta|paneer|queso|quesillo|oaxaca|monterey jack|gruy[eè]re|provolone|swiss|yogh?urt|irish cream|mashed potatoes|naan|brioche|mascarpone|cr[eè]me fra[iî]che|kefir|quark|labneh|halloumi|burrata|custard|ice cream|dulce de leche|queso fresco|cotija|cheese curds)/i;
const DAIRY_UNSURE = /\b(?:bread|rolls|buns|pav|english muffins|puff pastry|pie crusts?|empanada dough|paratha|roti|cornbread|gingersnap|chocolate(?! bitters))/i;
const EGG = /\b(?:eggs?\b|egg (?:white|yolk)s?|yolks?|mayo|mayonnaise|tartar sauce|egg noodles|brioche|challah)/i;
const EGG_UNSURE = /\b(?:lasagna noodles|dumpling wrappers|spring roll wrappers|empanada dough|tempura bits|gingersnap)/i;
const HONEY = /\b(?:honey(?!dew|comb)|gardenia mix)/i;
const FINED = /\b(?:wine|champagne|prosecco|vermouth|sherry|port\b|beer|lager|stout|dubonnet|marsala|sake|shaoxing)/i;
const VEGETARIAN_OK = /\b(?:vegan|plant-based|vegetarian|meatless)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g;
const VEGAN_OK = /\b(?:vegan|plant-based)(?: (?!and\b|or\b|with\b|plus\b)[a-z'-]+){1,3}/g;

/** What a photo of this recipe must leave out, from its ingredient list. Empty when that can't be said for sure. */
export function image_diet_note(ingredients = []) {
  const items = ingredients.map((i) => String(i ?? "").toLowerCase().normalize("NFC"));
  if (!items.length) return "";
  const read = (text, qualified) => text.replace(qualified, " ok ").replace(PLANT_WORDS, " ok ");
  const vegetarian = items.every((i) => {
    const t = read(i, VEGETARIAN_OK);
    return !MEAT.test(t) && !RENNET.test(t) && !MEAT_UNSURE.test(t);
  });
  if (!vegetarian) return "";
  const vegan = items.every((i) => {
    const t = read(i, VEGAN_OK);
    return ![DAIRY, EGG, HONEY, DAIRY_UNSURE, EGG_UNSURE, FINED].some((words) => words.test(t));
  });
  return vegan
    ? "It is vegan: show no meat, poultry, fish, seafood, eggs, dairy or cheese anywhere in the picture."
    : "It is vegetarian: show no meat, poultry, fish or seafood anywhere in the picture.";
}

/**
 * The house style, refined with Ben on 2026-11-14 from his ChatGPT tests (moscow mule, cosmopolitan, margarita):
 * eye level, dark slate, a few fresh key ingredients beside the dish, one side light, full frame, no text.
 * When the recipe is known, the photo shows the dish as that recipe makes it (its glass, garnish and main
 * ingredients), not the way it is traditionally served: a vegetarian cou-cou isn't shown with flying fish. Nothing the
 * recipe doesn't contain is added, and a vegetarian or vegan recipe says so.
 */
export function image_prompt(kind, name, details = {}) {
  const dish = normalize_dish_name(name);
  const glass = detail(details.glass);
  const garnish = detail(details.garnish);
  const listed = (Array.isArray(details.ingredients) ? details.ingredients : []).map((i) => detail(i, 30)).filter(Boolean);
  const ingredients = listed.slice(0, 3);
  const known = listed.length > 0;
  const subject =
    kind === "cocktail"
      ? `a classic ${dish} ${glass ? `in a ${glass}` : "in its classic glass"} ${garnish ? `with ${garnish}` : "with its classic garnish"}, backlit so the drink glows clear and appetising`
      : known
        ? `${dish} made from ${listed.slice(0, 6).join(", ")}, plated simply as this recipe makes it, looking fresh and appetising`
        : `${dish}, plated the classic way it is usually served, looking fresh and appetising`;
  const props = ingredients.length ? `a few fresh key ingredients beside it (${ingredients.join(", ")})` : "a few fresh key ingredients beside it";
  const diet = image_diet_note(Array.isArray(details.ingredients) ? details.ingredients : []);
  return [
    `Editorial food photograph of ${subject}.`,
    known ? "Show only foods from this recipe: no added sides, sauces, toppings, meat or fish it doesn't list." : "",
    diet,
    `Eye-level, slightly angled view; dark slate surface with ${props}; near-black background;`,
    "dark, moody lighting from one side; rich, true-to-life colour; shallow depth of field;",
    "the photo fills the whole frame with no borders.",
    "No people, no hands, no text, no labels, no logos, no brand names.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Every dish and drink that has a hand-picked photo, as library keys. Only these can be opened from the Home photo wall. */
export function curated_keys(curated_dir = CURATED_DIR) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(curated_dir, "manifest.json"), "utf8"));
  } catch {
    return new Set();
  }
  const keys = new Set();
  for (const photo of manifest.photos || []) for (const name of photo.names || []) {
    const key = image_key(photo.kind, name);
    if (key) keys.add(key);
  }
  return keys;
}

/** One searchable entry per curated image, including alternative names. Read once: the photos only change with a deploy. */
const catalogs = new Map();
export function curated_catalog(curated_dir = CURATED_DIR) {
  if (catalogs.has(curated_dir)) return catalogs.get(curated_dir);
  const catalog = read_catalog(curated_dir);
  if (catalog.length) catalogs.set(curated_dir, catalog); // an unreadable list is tried again next time
  return catalog;
}

function read_catalog(curated_dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(curated_dir, "manifest.json"), "utf8"));
    return (manifest.photos || []).flatMap((photo) => {
      const names = Array.isArray(photo.names) ? photo.names.filter((name) => typeof name === "string" && image_key(photo.kind, name)) : [];
      if (!names.length || !/^[a-z0-9-]+\.jpg$/.test(photo.file)) return [];
      return [{ name: names[0], kind: photo.kind, aliases: names.slice(1), image: `/images/${image_key(photo.kind, names[0])}.jpg` }];
    });
  } catch {
    return [];
  }
}

/** Copies the hand-picked photos (data/curated-photos) into the library, under every name each one covers. */
export function install_curated(dir, curated_dir = CURATED_DIR) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(curated_dir, "manifest.json"), "utf8"));
  } catch {
    return 0;
  }
  let installed = 0;
  for (const photo of manifest.photos || []) {
    if (!/^[a-z0-9-]+\.jpg$/.test(photo.file)) continue;
    for (const name of photo.names || []) {
      const key = image_key(photo.kind, name);
      if (!key || existsSync(join(dir, `${key}.jpg`))) continue;
      copyFileSync(join(curated_dir, photo.file), join(dir, `${key}.jpg`));
      installed += 1;
    }
  }
  return installed;
}

export function create_image_library({ env = {}, store, fetch_impl = fetch, dir = env.MM_IMAGE_DIR, curated_dir = CURATED_DIR, log = console }) {
  const enabled = env.MM_IMAGES_ENABLED !== "0" && Boolean(dir);
  const model = env.MM_IMAGE_MODEL || "gpt-image-2";
  const cost = Number(env.MM_IMAGE_PRICE_USD || 0.06);
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("MM_IMAGE_PRICE_USD must be a positive number.");
  if (enabled) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    install_curated(dir, curated_dir);
  }
  const in_flight = new Map();
  const curated = curated_keys(curated_dir);

  // Photos are cached as immutable, so a photo made again after one is retired is published under a new file name
  // (still a plain library address every installed app accepts), and nobody keeps seeing the retired one.
  const retired_count = new Map();
  if (dir && existsSync(join(dir, "retired")))
    for (const f of readdirSync(join(dir, "retired"))) {
      const key = f.slice(0, 32);
      if (/^[a-f0-9]{32}-/.test(f)) retired_count.set(key, (retired_count.get(key) ?? 0) + 1);
    }
  const name_of = (key, n) => `${n ? createHash("sha256").update(`${key}#${n}`).digest("hex").slice(0, 32) : key}.jpg`;
  const file_of = (key) => name_of(key, retired_count.get(key) ?? 0);
  // A retired photo's address, saved in someone's recipe, leads to the photo that replaced it.
  const replaced_by = new Map();
  const note_replaced = (key) => {
    for (let n = 0; n < (retired_count.get(key) ?? 0); n += 1) replaced_by.set(name_of(key, n), key);
  };
  for (const key of retired_count.keys()) note_replaced(key);
  const url_for = (key) => `/images/${file_of(key)}`;

  async function generate({ key, kind, name, user_id, details }) {
    let request_id;
    try {
      request_id = store.reserve_image({ user_id, model, cost });
    } catch (error) {
      if (error instanceof AiLimitError) return store.set_image({ key, kind, name, status: "failed" });
      throw error;
    }
    store.set_image({ key, kind, name, status: "pending" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
    try {
      const response = await fetch_impl(RESPONSES_URL, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json", "X-Client-Request-Id": request_id },
        body: JSON.stringify({
          model,
          prompt: image_prompt(kind, name, details),
          size: "1024x1536",
          quality: env.MM_IMAGE_QUALITY || "medium",
          output_format: "jpeg",
          output_compression: 82,
          n: 1,
        }),
      });
      const provider_request_id = response.headers?.get?.("x-request-id") || null;
      if (!response.ok) {
        store.finish_image(request_id, { status: response.status < 500 ? "rejected" : "provider-error", provider_request_id });
        store.set_image({ key, kind, name, status: "failed" });
        log.warn?.("Cover photo failed", { status: response.status });
        return;
      }
      const body = await response.json();
      const bytes = Buffer.from(String(body?.data?.[0]?.b64_json || ""), "base64");
      // Only a real JPEG of sensible size is published.
      if (bytes.length < 1000 || bytes.length > 8_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid image");
      const temp = join(dir, `.${key}.${randomUUID()}.tmp`);
      writeFileSync(temp, bytes, { mode: 0o644 });
      renameSync(temp, join(dir, file_of(key)));
      store.finish_image(request_id, { status: "completed", provider_request_id });
      store.set_image({ key, kind, name, status: "ready" });
    } catch (error) {
      store.finish_image(request_id, { status: "unknown" });
      store.set_image({ key, kind, name, status: "failed" });
      log.warn?.("Cover photo failed", { reason: error?.name === "AbortError" ? "timed out" : "error" });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    /**
     * Where this dish's photo stands. Starts creating it in the background if nobody has yet.
     * Returns { status: "ready", url } | { status: "pending", url: null } | { status: "unavailable", url: null }.
     */
    /** Whether a dish already has a photo, without ever starting a new one. */
    peek({ kind, name }) {
      const key = image_key(kind, name);
      if (!enabled || !key) return { status: "unavailable", url: null };
      if (existsSync(join(dir, file_of(key)))) return { status: "ready", url: url_for(key) };
      return { status: in_flight.has(key) ? "pending" : "unavailable", url: null };
    },
    status({ kind, name, user_id, details }) {
      const key = image_key(kind, name);
      if (!enabled || !key) return { status: "unavailable", url: null };
      if (existsSync(join(dir, file_of(key)))) return { status: "ready", url: url_for(key) };
      if (in_flight.has(key)) return { status: "pending", url: null };
      // A retired photo is only made again from its recipe: one made from the name alone could repeat the mistake
      // that got it retired ("flying fish" with a vegetarian cou-cou).
      if (retired_count.get(key) && !details?.ingredients?.length) return { status: "unavailable", url: null };
      const row = store.get_image(key);
      if (row?.status === "failed" && Date.now() - Date.parse(row.updated_at) < RETRY_FAILED_AFTER_MS) return { status: "unavailable", url: null };
      const job = generate({ key, kind, name: normalize_dish_name(name), user_id, details }).finally(() => in_flight.delete(key));
      in_flight.set(key, job);
      job.catch(() => {});
      return { status: "pending", url: null };
    },
    /**
     * Takes a photo out of the library after a person checked a report about it ("the photo shows meat on a vegetarian
     * dish"), so the next view creates a new one from the recipe. The old file is kept aside, never deleted, and a
     * hand-picked photo can't be retired this way. Returns whether a photo was retired.
     */
    retire({ kind, name }) {
      const key = image_key(kind, name);
      if (!enabled || !key || curated.has(key)) return false;
      const file = join(dir, file_of(key));
      if (!existsSync(file)) return false;
      mkdirSync(join(dir, "retired"), { recursive: true });
      renameSync(file, join(dir, "retired", `${key}-${Date.now()}.jpg`));
      retired_count.set(key, (retired_count.get(key) ?? 0) + 1);
      note_replaced(key);
      store.set_image({ key, kind, name: normalize_dish_name(name), status: "retired" });
      return true;
    },
    /** For the seed script and tests: wait for every photo being created right now. */
    async settled() {
      await Promise.allSettled([...in_flight.values()]);
    },
    /**
     * The current address for a retired photo's address, once its replacement is ready; null otherwise. Lets a saved
     * recipe that only kept the old address find the new photo.
     */
    moved(file) {
      if (!enabled || !FILE_NAME.test(file)) return null;
      const key = replaced_by.get(file);
      if (!key || existsSync(join(dir, file))) return null;
      return existsSync(join(dir, file_of(key))) ? url_for(key) : null;
    },
    /** Reads a published photo for the public /images/ route. Only exact library file names are accepted. */
    read(file) {
      if (!enabled || !FILE_NAME.test(file)) return null;
      try {
        return readFileSync(join(dir, file));
      } catch {
        return null;
      }
    },
  };
}
