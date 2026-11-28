import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { create_app } from "../server/app.js";
import { curated_keys, image_key } from "../server/dish_images.js";
import { configure } from "../server/main.js";
import { PremiumVerificationError } from "../server/premium_access.js";
import {
  ADDITIONS, DIETS, addition_payload, adds_what_it_promised, identify_payload, parse_addition_request, parse_image, parse_recipe_request,
  recipe_payload, review_payload, validate_recipe, with_detected_allergens,
} from "../server/recipe_ai.js";
import { create_usage_store } from "../server/usage_store.js";

const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64")}`;
const RECIPE = {
  title: "Classic Margarita", description: "Tequila, lime and orange liqueur.", servings: 1, prep_minutes: 5, cook_minutes: 0,
  ingredients: [{ amount: "2", unit: "oz", item: "blanco tequila" }, { amount: "1", unit: "oz", item: "fresh lime juice" }],
  steps: ["Shake with ice.", "Strain into a salt-rimmed glass."], allergens: [],
  cocktail: { glass: "rocks", garnish: "lime wheel", alcoholic: true, non_alcoholic_version: "Swap tequila for lime soda." }, note: "",
};
const IDENTIFIED = { kind: "cocktail", guesses: [{ name: "Margarita", confidence: "high" }, { name: "Paloma", confidence: "low" }] };

function provider(reply, { status = 200, delay = 0 } = {}) {
  const calls = [];
  const fetch_impl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const body = typeof reply === "function" ? reply(calls.length) : reply;
    return {
      ok: status < 400, status, headers: { get: () => "req_test" },
      json: async () => status < 400 ? {
        status: "completed", usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200 },
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: typeof body === "string" ? body : JSON.stringify(body) }] }],
      } : { error: { code: "server_error", message: "sk-should-never-be-echoed" } },
    };
  };
  return { fetch_impl, calls };
}

async function start({ reply = IDENTIFIED, status, delay, premium = async () => false, env = {}, featured } = {}) {
  const store = create_usage_store(env);
  const { fetch_impl, calls } = provider(reply, { status, delay });
  const warnings = [];
  const authorize = async (request) => {
    const m = /^Bearer (\S+)$/.exec(request.headers.authorization || "");
    if (!m) return false;
    // "alice@fresh" stands for alice right after she entered her password; plain "alice" signed in long ago.
    const fresh = m[1].endsWith("@fresh");
    return fresh ? { uid: m[1].slice(0, -"@fresh".length), auth_time: Math.floor(Date.now() / 1000) } : { uid: m[1] };
  };
  const handle = create_app({ env: { OPENAI_API_KEY: "sk-test-key", ...env }, store, authorize, premium, featured, fetch_impl, log: { warn: (...a) => warnings.push(a) } });
  const server = createServer(handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { user = "alice", body, raw, method = body === undefined && raw === undefined ? "GET" : "POST" } = {}) => fetch(base + path, {
    method,
    headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body !== undefined || raw ? { "Content-Type": "application/json" } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }).then(async (r) => ({ status: r.status, json: await r.json(), headers: r.headers }));
  return { base, call, calls, store, warnings, close: () => new Promise((r) => server.close(r)) };
}

test("requests without a signed-in account are refused before any work", async (t) => {
  const s = await start(); t.after(s.close);
  const r = await s.call("/api/identify", { user: null, body: { image: JPEG } });
  assert.equal(r.status, 401);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.call("/healthz", { user: null })).json.ok, true);
});

test("a photo returns only guesses (no recipe until the person asks), and uses one free photo", async (t) => {
  const s = await start(); t.after(s.close);
  const r = await s.call("/api/identify", { body: { image: JPEG } });
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, "cocktail");
  assert.equal(r.json.guesses.length, 2);
  assert.equal(r.json.recipe, undefined);
  assert.equal(s.calls.length, 1, "naming the photo is the only AI request");
  assert.equal(r.json.free_photos_left, 2);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const sent = s.calls[0].body;
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.equal(sent.input[0].content[1].type, "input_image");
  assert.match(sent.safety_identifier, /^[0-9a-f]{64}$/);
  assert.notEqual(sent.safety_identifier, "alice");
  const [row] = s.store.records();
  assert.equal(row.status, "completed");
  assert.equal(row.usage_known, 1);
  assert.equal(row.total_tokens, 1200);
});

test("'not food' and unusable replies give the free photo back", async (t) => {
  const replies = [{ kind: "not_food", guesses: [], recipe: null }, "not json", { kind: "cocktail", guesses: [{ name: "Margarita", confidence: "certain" }] }];
  const s = await start({ reply: (n) => replies[n - 1] }); t.after(s.close);
  assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).json.kind, "not_food");
  assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).status, 502);
  assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).status, 502);
  assert.equal((await s.call("/api/allowance")).json.free_photos_left, 3);
  assert.ok(s.warnings.length >= 2);
  assert.ok(!JSON.stringify(s.warnings).includes("not json"), "logs never contain the model's reply");
});

test("a blank or black photo is reported as unusable, works for older apps, and gives the free photo back", async (t) => {
  const s = await start({ reply: () => ({ kind: "unusable", guesses: [] }) }); t.after(s.close);
  const found = (await s.call("/api/identify", { body: { image: JPEG } })).json;
  assert.equal(found.kind, "not_food", "older apps read it as not food");
  assert.equal(found.reason, "unusable");
  assert.equal(found.free_photos_left, 3);
  assert.equal((await s.call("/api/allowance")).json.free_photos_left, 3);
  assert.match(identify_payload("data:image/jpeg;base64,x").instructions, /too dark or blurry to see what is in it, set "kind" to "unusable"/);
  assert.match(identify_payload("data:image/jpeg;base64,x").instructions, /A dim but recognisable photo is not unusable/);
});

test("after 3 free photos the next one is refused before calling OpenAI", async (t) => {
  const s = await start(); t.after(s.close);
  for (let i = 0; i < 3; i++) assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).status, 200);
  const r = await s.call("/api/identify", { body: { image: JPEG } });
  assert.equal(r.status, 402);
  assert.equal(r.json.code, "FREE_PHOTOS_USED");
  assert.equal(s.calls.length, 3);
  // Another account is unaffected.
  assert.equal((await s.call("/api/identify", { user: "bob", body: { image: JPEG } })).status, 200);
});

test("two uploads at once cannot both use the last free photo", async (t) => {
  const s = await start({ delay: 50, env: { MM_FREE_PHOTOS: "1" } }); t.after(s.close);
  const results = await Promise.all([s.call("/api/identify", { body: { image: JPEG } }), s.call("/api/identify", { body: { image: JPEG } })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 402]);
  assert.equal(s.calls.length, 1);
});

test("subscribers are not limited by free photos; an unverifiable subscription fails safely", async (t) => {
  const s = await start({ premium: async () => true, env: { MM_FREE_PHOTOS: "0" } }); t.after(s.close);
  const r = await s.call("/api/identify", { body: { image: JPEG } });
  assert.equal(r.status, 200);
  assert.equal(r.json.free_photos_left, null);
  const down = await start({ premium: async () => { throw new PremiumVerificationError(); } }); t.after(down.close);
  assert.equal((await down.call("/api/identify", { body: { image: JPEG } })).status, 503);
  assert.equal(down.calls.length, 0);
});

test("a provider error keeps the cost reservation, returns no provider text, and gives the photo back", async (t) => {
  const s = await start({ status: 500 }); t.after(s.close);
  const r = await s.call("/api/identify", { body: { image: JPEG } });
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes("sk-"));
  const [row] = s.store.records();
  assert.equal(row.status, "provider-error");
  assert.ok(row.estimated_cost_usd > 0);
  assert.equal(s.store.free_photos_left("alice"), 3);
});

test("bad uploads are rejected without calling OpenAI", async (t) => {
  const s = await start(); t.after(s.close);
  const fake_jpeg = `data:image/jpeg;base64,${Buffer.from("this is not really a photo at all").toString("base64")}`;
  assert.equal((await s.call("/api/identify", { body: { image: fake_jpeg } })).status, 400);
  assert.equal((await s.call("/api/identify", { body: { image: "https://example.com/x.jpg" } })).status, 400);
  assert.equal((await s.call("/api/identify", { raw: "{not json" })).status, 400);
  const huge = `data:image/jpeg;base64,${Buffer.alloc(5 * 1024 * 1024, 1).toString("base64")}`;
  assert.equal((await s.call("/api/identify", { body: { image: huge } })).status, 413);
  assert.equal(s.calls.length, 0);
});

test("free diet versions of library dishes work for a new account with no photos, and are made once for everyone", async (t) => {
  const s = await start({ reply: RECIPE, featured: curated_keys() }); t.after(s.close);
  for (const diet of ["low-carb", "non-alcoholic"]) {
    const made = await s.call("/api/recipe", { user: "newbie", body: { name: "Gimlet", kind: "cocktail", diet } });
    assert.equal(made.status, 200, `${diet} is free with zero photos`);
  }
  assert.equal(s.calls.length, 2);
  // Another account asking for the same version gets the kept one: no AI request.
  assert.equal((await s.call("/api/recipe", { user: "other", body: { name: "gimlet", kind: "cocktail", diet: "low-carb" } })).status, 200);
  assert.equal(s.calls.length, 2);
  // They use no free photo and no follow-up, so photo recognition limits are untouched.
  assert.equal(s.store.free_photos_left("newbie"), 3);
  assert.deepEqual(s.store.records().filter((r) => r.user_id === "newbie").map((r) => r.feature), ["diet", "diet"]);
  // Vegetarian and vegan stay Premium even for library dishes, before anything is spent.
  for (const diet of ["vegetarian", "vegan"]) {
    const refused = await s.call("/api/recipe", { user: "newbie", body: { name: "Margarita", kind: "cocktail", diet } });
    assert.equal(refused.json.code, "PREMIUM_VERSIONS");
  }
  assert.equal(s.calls.length, 2);
  // A name the library doesn't have is still a follow-up to a photo: a diet request can't stand in for one.
  const unknown = await s.call("/api/recipe", { user: "newbie", body: { name: "Imaginary Test Dish Gamma", kind: "meal", diet: "low-carb" } });
  assert.equal(unknown.json.code, "FREE_VERSIONS_USED");
});

test("follow-up recipes (other guesses, diet versions of new dishes) need a counted photo and are capped for free users", async (t) => {
  const s = await start({ reply: (n) => (n === 1 ? IDENTIFIED : RECIPE) }); t.after(s.close);
  const ask = { name: "Paloma", kind: "cocktail", diet: "non-alcoholic" };
  // bob has never taken a photo, so no free follow-ups.
  const none = await s.call("/api/recipe", { user: "bob", body: ask });
  assert.equal(none.status, 402);
  // Not "free photos used": bob still has all 3 of those.
  assert.equal(none.json.code, "FREE_VERSIONS_USED");
  assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await s.call("/api/recipe", { body: ask })).status, 200);
  assert.equal((await s.call("/api/recipe", { body: ask })).json.code, "FREE_VERSIONS_USED");
  assert.match(s.calls[1].body.input[0].content[0].text, /non-alcoholic/);
  assert.equal(s.store.free_photos_left("alice"), 2, "follow-ups don't use free photos");
  assert.equal((await s.call("/api/recipe", { body: { ...ask, diet: "carnivore" } })).status, 400);
});

test("a name typed after an unreadable photo uses a free photo, so it works for new accounts and stops at the limit", async (t) => {
  const s = await start({ reply: RECIPE }); t.after(s.close);
  const fix = { name: "Chicken parmesan", kind: "meal", correction: true };
  // carol has taken no photo that counted (hers wasn't food), but still has her 3 free photos.
  for (let i = 0; i < 3; i++) assert.equal((await s.call("/api/recipe", { user: "carol", body: fix })).status, 200);
  assert.equal(s.store.free_photos_left("carol"), 0);
  assert.equal((await s.call("/api/recipe", { user: "carol", body: fix })).json.code, "FREE_PHOTOS_USED");
  // A correction gets the usual follow-ups, like a photo that worked.
  assert.equal((await s.call("/api/recipe", { user: "carol", body: { name: "Chicken parmesan", kind: "meal", diet: "gluten-free" } })).status, 200);
  // Corrections can't be combined with a diet or sent as anything but true/false.
  assert.equal((await s.call("/api/recipe", { user: "dan", body: { ...fix, diet: "vegan" } })).status, 400);
  assert.equal((await s.call("/api/recipe", { user: "dan", body: { ...fix, correction: "yes" } })).status, 400);
});

test("a correction whose reply can't be used doesn't use up a free photo", async (t) => {
  const s = await start({ reply: "{not a recipe" }); t.after(s.close);
  assert.notEqual((await s.call("/api/recipe", { user: "erin", body: { name: "Pho", kind: "meal", correction: true } })).status, 200);
  assert.equal(s.store.free_photos_left("erin"), 3);
});

test("reply and request validation", () => {
  assert.throws(() => validate_recipe({ ...RECIPE, ingredients: [] }));
  assert.throws(() => validate_recipe({ ...RECIPE, servings: -1 }));
  assert.equal(validate_recipe({ ...RECIPE, allergens: ["milk", "milk"] }).allergens.length, 1);
  assert.equal(parse_image(JPEG.replace("image/jpeg", "image/png")), null, "the label must match the real file type");
  assert.equal(parse_recipe_request({ name: "  ", kind: "meal" }), null);
  assert.equal(parse_recipe_request({ name: "Pad thai", kind: "drink" }), null);
  assert.deepEqual(parse_recipe_request({ name: "Pad thai", kind: "meal" }), { name: "Pad thai", kind: "meal", diet: null, correction: false });
});

test("production refuses to start without its secrets or with the development sign-in bypass", () => {
  assert.throws(() => configure({ NODE_ENV: "production", OPENAI_API_KEY: "x" }), /FIREBASE_PROJECT_ID, MM_AI_USAGE_DB, REVENUECAT_SECRET_API_KEY/);
  assert.throws(() => configure({ NODE_ENV: "production", OPENAI_API_KEY: "x", FIREBASE_PROJECT_ID: "p", MM_AI_USAGE_DB: "/tmp/x.db",
    REVENUECAT_SECRET_API_KEY: "k", MM_IMAGE_DIR: "/tmp/mm-images", MM_DEV_ALLOW_UNAUTHENTICATED: "1" }), /must not be set in production/);
  assert.throws(() => configure({ OPENAI_API_KEY: "x" }), /FIREBASE_PROJECT_ID, or MM_DEV_ALLOW_UNAUTHENTICATED/);
  assert.ok(configure({ OPENAI_API_KEY: "x", MM_DEV_ALLOW_UNAUTHENTICATED: "1" }).store);
});

test("photo-wall recipes are made once, shared by everyone, and use no free photo or recipe", async (t) => {
  const featured = curated_keys();
  assert.ok(featured.has(image_key("cocktail", "Margarita")), "the repo's hand-picked photos are on the wall list");
  const s = await start({ reply: RECIPE, featured, delay: 30 }); t.after(s.close);
  // A brand-new free user, with no photos taken, can open a wall recipe.
  const [a, b] = await Promise.all([
    s.call("/api/featured-recipe", { user: "alice", body: { name: "Margarita", kind: "cocktail" } }),
    s.call("/api/featured-recipe", { user: "bob", body: { name: "margarita", kind: "cocktail" } }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(a.json.recipe.title, "Classic Margarita");
  assert.equal(b.json.recipe.title, "Classic Margarita");
  assert.equal(s.calls.length, 1, "two people opening the same dish at once make one recipe");
  const again = await s.call("/api/featured-recipe", { user: "carol", body: { name: "Margarita", kind: "cocktail" } });
  assert.equal(again.json.recipe.title, "Classic Margarita");
  assert.equal(s.calls.length, 1, "later visitors get the saved recipe");
  assert.equal((await s.call("/api/allowance", { user: "alice" })).json.free_photos_left, 3);
});

test("only photo-wall dishes, with no diet, can be opened for free", async (t) => {
  const s = await start({ reply: RECIPE, featured: curated_keys() }); t.after(s.close);
  assert.equal((await s.call("/api/featured-recipe", { body: { name: "Imaginary Test Dish Gamma", kind: "meal" } })).status, 404);
  assert.equal((await s.call("/api/featured-recipe", { body: { name: "Margarita", kind: "meal" } })).status, 404);
  assert.equal((await s.call("/api/featured-recipe", { body: { name: "Margarita", kind: "cocktail", diet: "vegan" } })).status, 400);
  assert.equal((await s.call("/api/featured-recipe", { user: null, body: { name: "Margarita", kind: "cocktail" } })).status, 401);
  assert.equal(s.calls.length, 0);
});

test("diet versions get each diet's rules, and every recipe is asked to name ingredients precisely", () => {
  for (const diet of DIETS) {
    const text = recipe_payload({ name: "Manhattan", kind: "cocktail", diet }).input[0].content[0].text;
    assert.match(text, new RegExp(`Make it ${diet}`));
    assert.ok(text.length > 120, `${diet} has rules`);
  }
  assert.match(recipe_payload({ name: "Manhattan", kind: "cocktail", diet: "vegan" }).input[0].content[0].text, /vegan sweet vermouth/);
  assert.match(recipe_payload({ name: "Pesto", kind: "meal", diet: "vegetarian" }).input[0].content[0].text, /vegetarian hard cheese/);
  assert.match(recipe_payload({ name: "Pesto", kind: "meal" }).instructions, /vegetable broth/);
  assert.match(identify_payload("data:image/jpeg;base64,AA").instructions, /Never write a recipe/);
});

test("deleting an account needs a fresh sign-in, removes its data, and refuses the account afterwards", async (t) => {
  const s = await start(); t.after(s.close);
  assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).status, 200);
  assert.equal((await s.call("/api/recipe-rating", { body: { kind: "cocktail", dish: "Margarita", stars: 4, made: true, tags: [], note: "Nice" } })).status, 200);
  assert.equal((await s.call("/api/feedback", { body: { category: "feature", title: "More drinks", description: "Please add more tiki drinks.", requestId: randomUUID() } })).status, 200);

  assert.equal(s.store.feedback.dashboard("", 0).features.length, 1);
  const stale = await s.call("/api/account/delete", { body: {} });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.code, "RECENT_SIGN_IN_REQUIRED");
  assert.ok(s.store.records().some((row) => row.user_id === "alice"));

  const done = await s.call("/api/account/delete", { user: "alice@fresh", body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.json.ok, true);
  const rows = s.store.records();
  assert.ok(rows.length > 0, "usage costs still count towards the monthly budget");
  assert.ok(rows.every((row) => row.user_id !== "alice" && row.provider_request_id === null));
  assert.equal(s.store.ratings.summary().dishes.length, 0);
  assert.equal(s.store.feedback.dashboard("", 0).features.length, 0);

  const after = await s.call("/api/allowance");
  assert.equal(after.status, 401);
  assert.equal(after.json.code, "ACCOUNT_DELETED");
  assert.equal((await s.call("/api/allowance", { user: "bob" })).status, 200);
  // If removing the sign-in failed on the phone, trying again still works.
  assert.equal((await s.call("/api/account/delete", { user: "alice@fresh", body: {} })).status, 200);
});

test("the privacy policy and terms are public pages with a strict content policy", async (t) => {
  const s = await start(); t.after(s.close);
  for (const path of ["/privacy", "/terms"]) {
    const r = await fetch(s.base + path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.doesNotMatch(r.headers.get("content-security-policy"), /script-src/);
    const html = await r.text();
    assert.match(html, /turelapps@gmail\.com/);
    assert.match(html, /Benjamin Major/);
    assert.doesNotMatch(html, /\{\{/);
  }
  assert.equal((await fetch(s.base + "/legal/legal.css")).status, 200);
  assert.equal((await fetch(s.base + "/legal/../app.js")).status, 404);
});

test("deleting an account also removes its RevenueCat billing profile, and stays retryable if that fails", async (t) => {
  const store = create_usage_store({});
  const calls = [];
  let status = 503;
  const fetch_impl = async (url, options) => {
    calls.push({ url, method: options.method, auth: options.headers.Authorization });
    return { ok: status < 400, status, body: null };
  };
  const authorize = async () => ({ uid: "alice", auth_time: Math.floor(Date.now() / 1000) });
  const handle = create_app({ env: { OPENAI_API_KEY: "sk-test-key", REVENUECAT_SECRET_API_KEY: "sk_rc_test" }, store, authorize, premium: async () => false, fetch_impl, log: { warn() {} } });
  const server = createServer(handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const remove = () => fetch(`http://127.0.0.1:${server.address().port}/api/account/delete`, {
    method: "POST", headers: { Authorization: "Bearer x", "Content-Type": "application/json" }, body: "{}",
  });
  const failed = await remove();
  assert.equal(failed.status, 503);
  assert.equal(store.account_deleted("alice"), false, "nothing is marked deleted until billing data is gone");
  status = 404; // already gone counts as done
  assert.equal((await remove()).status, 200);
  assert.equal(store.account_deleted("alice"), true);
  assert.deepEqual(calls[0], { url: "https://api.revenuecat.com/v1/subscribers/alice", method: "DELETE", auth: "Bearer sk_rc_test" });
});

test("listed beta testers get Premium without paying; everyone else is checked with RevenueCat", async () => {
  const { with_premium_testers } = await import("../server/main.js");
  const checked = [];
  const paid = async (uid) => { checked.push(uid); return uid === "subscriber"; };
  const premium = with_premium_testers(paid, " tester-1 , tester-2,");
  assert.equal(await premium("tester-2"), true);
  assert.equal(await premium("subscriber"), true);
  assert.equal(await premium("someone"), false);
  assert.deepEqual(checked, ["subscriber", "someone"]);
  assert.equal(with_premium_testers(paid, ""), paid, "no list, no change");
});

const VEG_BASE = {
  title: "Lemon Chickpea Couscous Salad", servings: 4,
  ingredients: [{ amount: "1", unit: "cup", item: "dry couscous" }, { amount: "1", unit: "can", item: "chickpeas, drained" }],
  steps: ["Soak the couscous.", "Toss with the chickpeas."],
};
const with_items = (items) => ({ ...RECIPE, cocktail: null, title: "Salad", ingredients: items.map((item) => ({ amount: "1", unit: "", item })) });

test("vegetarian and vegan versions are Premium: free accounts are sent to the paywall before anything is spent", async (t) => {
  const s = await start({ reply: RECIPE }); t.after(s.close);
  for (const diet of ["vegetarian", "vegan"]) {
    const refused = await s.call("/api/recipe", { body: { name: "Chicken parmesan", kind: "meal", diet } });
    assert.equal(refused.status, 402);
    assert.equal(refused.json.code, "PREMIUM_VERSIONS");
  }
  assert.equal(s.calls.length, 0);
  const p = await start({ reply: RECIPE, premium: async () => true }); t.after(p.close);
  assert.equal((await p.call("/api/recipe", { body: { name: "Chicken parmesan", kind: "meal", diet: "vegan" } })).status, 200);
});

test("meat and dairy versions of vegetarian or vegan meals are Premium, adapt the recipe on screen, and must add what they promise", async (t) => {
  const ask = { name: "Lemon Chickpea Couscous Salad", kind: "meal", addition: "non-vegetarian", base: VEG_BASE };
  const free = await start({ reply: with_items(["chicken thighs"]) }); t.after(free.close);
  const refused = await free.call("/api/recipe-addition", { body: ask });
  assert.equal(refused.json.code, "PREMIUM_VERSIONS");
  assert.equal(free.calls.length, 0);

  const s = await start({ reply: with_items(["1 lb boneless chicken thighs", "dry couscous"]), premium: async () => true }); t.after(s.close);
  const made = await s.call("/api/recipe-addition", { body: ask });
  assert.equal(made.status, 200);
  assert.equal(made.json.recipe.title, "Salad");
  const sent = s.calls[0].body;
  assert.match(sent.instructions, /safe internal temperature/);
  assert.match(sent.input[0].content[0].text, /dry couscous/);

  // A reply that only pretends ("vegan butter", "peanut butter") is refused, not shown.
  const fake = await start({ reply: with_items(["vegan butter", "peanut butter", "coconut milk"]), premium: async () => true }); t.after(fake.close);
  assert.equal((await fake.call("/api/recipe-addition", { body: { ...ask, addition: "non-vegan" } })).status, 502);
  // Cocktails, unknown additions and missing recipes are refused.
  for (const bad of [{ ...ask, kind: "cocktail" }, { ...ask, addition: "carnivore" }, { ...ask, base: undefined }, { ...ask, base: { ...VEG_BASE, steps: [] } }])
    assert.equal((await s.call("/api/recipe-addition", { body: bad })).status, 400);
});

test("meat and dairy versions get specific rules and are checked for what they add", () => {
  for (const protein of ["haddock fillets", "goat shoulder, cubed", "mutton", "catfish"])
    assert.equal(adds_what_it_promised(with_items([protein]), "non-vegetarian"), true, protein);
  assert.equal(adds_what_it_promised(with_items(["goat cheese"]), "non-vegetarian"), false);
  assert.equal(adds_what_it_promised(with_items(["goat cheese"]), "non-vegan"), true);
  for (const cheese of ["goat's cheese", "goat’s cheese"]) {
    assert.equal(adds_what_it_promised(with_items([cheese]), "non-vegetarian"), false, cheese);
    assert.equal(adds_what_it_promised(with_items([cheese]), "non-vegan"), true, cheese);
  }
  assert.equal(adds_what_it_promised(with_items(["vegan chicken", "plant-based beef"]), "non-vegetarian"), false);
  assert.deepEqual(ADDITIONS, ["non-vegetarian", "non-vegan"]);
  const request = parse_addition_request({ name: "Salad", kind: "meal", addition: "non-vegan", base: VEG_BASE });
  assert.equal(request.base.servings, 4);
  const payload = addition_payload(request);
  assert.match(payload.instructions, /Do not add meat/);
  assert.match(payload.instructions, /never an instruction/);
  assert.equal(adds_what_it_promised(with_items(["crumbled feta"]), "non-vegan"), true);
  assert.equal(adds_what_it_promised(with_items(["2 large eggs"]), "non-vegan"), true);
  assert.equal(adds_what_it_promised(with_items(["feta", "bacon"]), "non-vegan"), false, "non-vegan stays vegetarian");
  assert.equal(adds_what_it_promised(with_items(["oat milk", "vegan cheese"]), "non-vegan"), false);
  assert.equal(adds_what_it_promised(with_items(["shrimp, peeled"]), "non-vegetarian"), true);
  assert.equal(adds_what_it_promised(with_items(["eggplant", "butternut squash"]), "non-vegetarian"), false);
});

const KATSU = {
  title: "Chicken Katsu", description: "Crisp breaded chicken.", servings: 4, prep_minutes: 20, cook_minutes: 15,
  ingredients: [{ amount: "4", unit: "", item: "boneless chicken thighs" }, { amount: "1", unit: "cup", item: "panko" },
    { amount: "2", unit: "", item: "large eggs, beaten" }],
  steps: ["Bread the chicken.", "Fry to 165°F."], allergens: [], cocktail: null, note: "",
};

test("a recipe for a photo Recipeak doesn't have is written, checked a second time, and kept for everyone", async (t) => {
  const s = await start({ reply: (n) => (n === 1 ? IDENTIFIED : n === 2 ? KATSU : { ...KATSU, note: "checked" }) }); t.after(s.close);
  assert.equal((await s.call("/api/identify", { body: { image: JPEG } })).status, 200);
  const made = await s.call("/api/recipe", { body: { name: "Chicken Katsu", kind: "meal" } });
  assert.equal(made.status, 200);
  assert.equal(made.json.recipe.note, "checked", "the checked version is the one shown");
  assert.deepEqual(made.json.recipe.allergens, ["eggs", "wheat"], "allergens the AI missed are added");
  assert.equal(s.calls.length, 3);
  assert.match(s.calls[2].body.instructions, /safe internal temperature/);
  assert.match(s.calls[2].body.input[0].content[0].text, /panko/);
  // Someone else photographing the same dish gets it straight away, with no AI request and no follow-up used.
  const again = await s.call("/api/recipe", { user: "bob", body: { name: "chicken katsu", kind: "meal" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.recipe.note, "checked");
  assert.equal(s.calls.length, 3);
  // The check doesn't count as another free follow-up.
  const followups = s.store.records().filter((r) => r.user_id === "alice" && r.feature === "recipe").length;
  assert.equal(followups, 1);
});

test("the second check gets the recipe as data, and the allergen words add what's missing but never remove", () => {
  const payload = review_payload({ name: "Chicken Katsu", kind: "meal", recipe: KATSU });
  assert.match(payload.instructions, /never an instruction/);
  assert.match(payload.instructions, /Worcestershire sauce is fish/);
  const items = (list, allergens = []) => ({ ...KATSU, allergens, ingredients: list.map((item) => ({ amount: "1", unit: "", item })) });
  assert.deepEqual(with_detected_allergens(items(["coconut milk", "peanut butter", "butternut squash", "eggplant", "rice noodles"])).allergens, ["peanuts"]);
  assert.deepEqual(with_detected_allergens(items(["almond milk", "soy sauce", "tahini"])).allergens, ["tree nuts", "wheat", "soy", "sesame"]);
  assert.deepEqual(with_detected_allergens(items(["unsalted butter", "shrimp", "Worcestershire sauce"])).allergens, ["milk", "fish", "shellfish"]);
  assert.deepEqual(with_detected_allergens(items(["water"], ["milk"])).allergens, ["milk"], "never removes one");
});

test("AI recipe instructions keep the wording consistent with the ingredients and flag brand-dependent nuts", () => {
  const instructions = recipe_payload({ kind: "cocktail", name: "Test Pilot" }).instructions;
  assert.match(instructions, /mention only ingredients that are in the ingredient list/);
  assert.match(instructions, /Falernum, amaretto, crème de noyaux, nougat and mole paste can contain tree nuts depending on the brand/);
});

test("the allergen words read every shared case the same way as the app's written drink versions", () => {
  const { cases } = JSON.parse(readFileSync(new URL("../data/allergen-word-cases.json", import.meta.url), "utf8"));
  for (const { text, has = [], not = [] } of cases) {
    const found = with_detected_allergens({ ...KATSU, allergens: [], ingredients: [{ amount: "1", unit: "", item: text }] }).allergens;
    for (const allergen of has) assert.ok(found.includes(allergen), `${text} contains ${allergen}`);
    for (const allergen of not) assert.ok(!found.includes(allergen), `${text} is not ${allergen}`);
  }
});

test("if the second check fails, the draft is shown (allergens topped up) but not kept", async (t) => {
  const s = await start({ premium: async () => true, reply: (n) => (n === 1 ? KATSU : "not json") }); t.after(s.close);
  const made = await s.call("/api/recipe", { body: { name: "Chicken Katsu", kind: "meal" } });
  assert.equal(made.status, 200);
  assert.deepEqual(made.json.recipe.allergens, ["eggs", "wheat"]);
  assert.equal(s.store.get_recipe("photo:" + image_key("meal", "Chicken Katsu")), null);
});

test("every AI recipe path adds allergens the model left out, including versions kept before this check existed", async (t) => {
  // The model lists butter and egg white but no allergens.
  const under_listed = {
    title: "Low-Carb Gimlet", description: "Gin and lime.", servings: 1, prep_minutes: 1, cook_minutes: 0,
    ingredients: [{ amount: "1", unit: "tbsp", item: "butter" }, { amount: "1", unit: "", item: "egg white" }, { amount: "2", unit: "oz", item: "gin" }],
    steps: ["Shake."], allergens: [], cocktail: { glass: "coupe", garnish: "lime", alcoholic: true, non_alcoholic_version: null }, note: "",
  };
  const s = await start({ reply: under_listed, premium: async () => true, featured: curated_keys() }); t.after(s.close);
  const allergens = async (path, body, user) => (await s.call(path, { body, user })).json.recipe.allergens;
  const both = ["milk", "eggs"]; // in the server's fixed allergen order
  assert.deepEqual(await allergens("/api/recipe", { name: "Gimlet", kind: "cocktail", diet: "low-carb" }), both, "free diet version");
  assert.deepEqual(await allergens("/api/recipe", { name: "Gimlet", kind: "cocktail", diet: "low-carb" }, "bob"), both, "the kept copy another account gets");
  assert.deepEqual(await allergens("/api/recipe", { name: "Bespoke soup", kind: "meal", correction: true }), both, "a name typed after an unreadable photo");
  assert.deepEqual(await allergens("/api/featured-recipe", { name: "Margarita", kind: "cocktail" }), both, "photo-wall recipe");
  // A version kept before the allergen check was added is checked when it is served.
  s.store.set_recipe({ key: `diet:${image_key("cocktail", "Negroni")}:low-carb`, kind: "cocktail", name: "Negroni", recipe: under_listed });
  const calls_before = s.calls.length;
  assert.deepEqual(await allergens("/api/recipe", { name: "Negroni", kind: "cocktail", diet: "low-carb" }), both, "older kept version");
  assert.equal(s.calls.length, calls_before, "served from the kept copy, with no AI request");
  // Meat and dairy versions too.
  const added = { ...under_listed, title: "Salad with chicken", cocktail: null, ingredients: [...under_listed.ingredients, { amount: "1", unit: "lb", item: "chicken breast" }] };
  const p = await start({ reply: added, premium: async () => true }); t.after(p.close);
  const made = await p.call("/api/recipe-addition", { body: { name: "Salad", kind: "meal", addition: "non-vegetarian",
    base: { title: "Salad", servings: 2, ingredients: [{ amount: "1", unit: "cup", item: "lettuce" }], steps: ["Toss."] } } });
  assert.deepEqual(made.json.recipe.allergens, both, "meat or dairy version");
});

test("plant foods named after 'vegan' aren't read as dairy, and the app's copy of the allergen words stays the server's", () => {
  const found = (item) => with_detected_allergens({ allergens: [], ingredients: [{ item }] }).allergens;
  assert.deepEqual(found("vegan almond milk"), ["tree nuts"], "almond milk is a nut, not milk, also after 'vegan'");
  assert.deepEqual(found("vegan cream cheese"), []);
  assert.deepEqual(found("vegan butter and milk"), ["milk"], "'and' ends the plant-based name");
  assert.deepEqual(found("butter"), ["milk"]);
  for (const item of ["coconut yogurt", "oat yoghurt", "apple butter"]) assert.deepEqual(found(item), [], item);
  // "Vegan" rules out dairy, eggs, fish and shellfish, never wheat (Codex review of 324facd).
  for (const item of ["vegan whole wheat bread", "vegan all-purpose flour", "vegan wheat noodles", "vegan bread"])
    assert.deepEqual(found(item), ["wheat"], item);
  assert.deepEqual(found("vegan fish sauce"), [], "a vegan fish sauce has no fish");
  // apps/mobile/src/recipes/allergenRisk.ts reads saved AI recipes with the same words.
  const app = readFileSync(new URL("../apps/mobile/src/recipes/allergenRisk.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../server/recipe_ai.js", import.meta.url), "utf8");
  const flat = (text) => text.replace(/\s+/g, " ").replace(/,\s*([}\]])/g, " $1").trim();
  const words = (source) => flat(source.match(/const ALLERGEN_WORDS(?::[^=]*)? = \{(.*?)\n\};/s)?.[1] ?? "");
  // Fixed patterns, one per constant (the security scan doesn't allow building a RegExp from a variable).
  const CONSTANTS = {
    NOT_AN_ALLERGEN: /const NOT_AN_ALLERGEN(?::[^=]*)? =\s*(.*?);\n/s,
    NOT_THIS_ALLERGEN: /const NOT_THIS_ALLERGEN(?::[^=]*)? =\s*(.*?);\n/s,
    CHECKED_ON_FULL_NAME: /const CHECKED_ON_FULL_NAME(?::[^=]*)? =\s*(.*?);\n/s,
  };
  assert.ok(words(app), "the app has ALLERGEN_WORDS");
  assert.equal(words(app), words(server), "ALLERGEN_WORDS");
  for (const [name, pattern] of Object.entries(CONSTANTS)) {
    const literal = (source) => flat(source.match(pattern)?.[1] ?? "");
    assert.ok(literal(app), name);
    assert.equal(literal(app), literal(server), name);
  }
});

test("explicit wheat is detected even without bread or flour in the ingredient name", () => {
  const found = (item) => with_detected_allergens({ allergens: [], ingredients: [{ item }] }).allergens;
  assert.deepEqual(found("wheat berries"), ["wheat"]);
  assert.deepEqual(found("vegan wheat germ"), ["wheat"]);
  assert.deepEqual(found("wheat-free rice noodles"), []);
});

test("a free-from word settles only the allergen it names (2026-11-27 E2E test, F2)", () => {
  const found = (item) => with_detected_allergens({ allergens: [], ingredients: [{ item }] }).allergens;
  for (const item of ["dairy-free cheese", "dairy-free butter", "milk-free chocolate", "egg-free mayonnaise", "nut-free pesto", "tree nut-free pesto", "peanut-free satay sauce"])
    assert.deepEqual(found(item), [], item);
  assert.deepEqual(found("dairy-free egg noodles"), ["eggs", "wheat"], "dairy-free says nothing about eggs or wheat");
  assert.deepEqual(found("dairy-free almond milk"), ["tree nuts"], "still a nut");
  assert.deepEqual(found("nut-free peanut butter"), ["peanuts"], "nut-free doesn't rule out peanuts");
  assert.deepEqual(found("dairy-free cheese and butter"), ["milk"], "'and' ends the free-from name");
  assert.deepEqual(found("lactose-free milk"), ["milk"], "lactose-free milk is still milk");
  assert.deepEqual(found("egg-free pasta"), ["wheat"]);
});
